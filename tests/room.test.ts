import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/shared/prng';
import type { ClientMessage } from '../src/shared/protocol';
import { handleMessage, viewFor, type Room } from '../src/shared/room';
import { HAND_SIZE, TIMER_MS } from '../src/shared/rules';

const rand = mulberry32(99);
const T0 = 5_000_000;

function send(room: Room | null, deviceId: string, msg: ClientMessage, now = T0) {
  return handleMessage(room, deviceId, msg, now, rand, 'ROOM');
}
function must(room: Room | null, deviceId: string, msg: ClientMessage, now = T0): Room {
  const out = send(room, deviceId, msg, now);
  if (out.error) throw new Error(`${out.error.code} ${out.error.detail ?? ''}`);
  return out.room!;
}
const hello = (deviceId: string, name: string, create = false): ClientMessage =>
  ({ t: 'hello', v: 3, deviceId, name, ...(create ? { create: { packs: ['core'] } } : {}) });

function lobby(): Room {
  let room = must(null, 'dev-a', hello('dev-a', 'Ada', true));
  room = must(room, 'dev-b', hello('dev-b', 'Bo'));
  room = must(room, 'dev-c', hello('dev-c', 'Cy'));
  return room;
}
const view = (room: Room, dev: string) => viewFor(room, dev, new Set(['dev-a', 'dev-b', 'dev-c']))!;

describe('rooms', () => {
  it('creates, joins and refuses to create over an existing room', () => {
    expect(send(null, 'dev-a', hello('dev-a', 'Ada')).error?.code).toBe('room-not-found');
    const room = lobby();
    expect(room.phase).toBe('lobby');
    expect(room.members.map((m) => m.name)).toEqual(['Ada', 'Bo', 'Cy']);
    expect(room.hostId).toBe(room.members[0].id);
    expect(send(room, 'dev-x', hello('dev-x', 'Eve', true)).error?.code).toBe('room-taken');
  });

  it('keeps the same seat on reconnect and de-duplicates names', () => {
    let room = lobby();
    const before = room.members[1].id;
    room = must(room, 'dev-b', hello('dev-b', 'Bo'));
    expect(room.members).toHaveLength(3);
    expect(room.members[1].id).toBe(before);
    room = must(room, 'dev-d', hello('dev-d', 'ada'));
    expect(room.members[3].name).toBe('ada 2');
  });

  it('only the host deals, and needs two players', () => {
    const solo = must(null, 'dev-a', hello('dev-a', 'Ada', true));
    expect(send(solo, 'dev-a', { t: 'start' }).error?.code).toBe('need-players');
    const room = lobby();
    expect(send(room, 'dev-b', { t: 'start' }).error?.code).toBe('not-host');
    const playing = must(room, 'dev-a', { t: 'start' });
    expect(playing.phase).toBe('playing');
    const ids = Object.values(playing.game!.players).flatMap((p) => p.hand.map((c) => c.id));
    expect(new Set(ids).size).toBe(3 * HAND_SIZE);
  });

  it('lets the host set phrase count and spiciness, clamped to sane values', () => {
    let room = must(null, 'dev-a', { t: 'hello', v: 3, deviceId: 'dev-a', name: 'Ada', create: { packs: ['core'], handSize: 7, spice: 4 } });
    expect(room.settings).toEqual({ handSize: 7, spice: 4, catchphrase: true });
    room = must(room, 'dev-b', hello('dev-b', 'Bo'));
    expect(send(room, 'dev-b', { t: 'configure', options: { packs: ['core'], handSize: 3 } }).error?.code).toBe('not-host');
    room = must(room, 'dev-a', { t: 'configure', options: { packs: ['core', 'travel', 'bogus'], handSize: 99, spice: 0 } });
    expect(room.settings).toEqual({ handSize: 8, spice: 1, catchphrase: true });
    expect(room.packs).toEqual(['core', 'travel']);
    room = must(room, 'dev-a', { t: 'configure', options: { packs: ['core'], handSize: 4, spice: 5 } });
    room = must(room, 'dev-a', { t: 'start' });
    expect(view(room, 'dev-b').you.hand).toHaveLength(4);
    expect(view(room, 'dev-b').settings).toEqual({ handSize: 4, spice: 5, catchphrase: true });
    expect(send(room, 'dev-a', { t: 'configure', options: { packs: ['core'], spice: 1 } }).error?.code).toBe('wrong-phase');
    // Inferno: the dealt hands lean hard but are still a mix overall.
    const heats = Object.values(room.game!.players).flatMap((p) => p.hand.map((c) => c.heat));
    expect(heats.filter((h) => h === 3).length).toBeGreaterThan(heats.length / 2);
    expect(new Set([...heats, ...room.game!.pile.slice(0, 20).map((p) => p.heat)]).size).toBe(3);
  });

  it('catchphrases can be switched off for a room', () => {
    let room = must(null, 'dev-a', { t: 'hello', v: 3, deviceId: 'dev-a', name: 'Ada', create: { packs: ['core'], catchphrase: false } });
    expect(room.settings.catchphrase).toBe(false);
    room = must(room, 'dev-b', hello('dev-b', 'Bo'));
    room = must(room, 'dev-a', { t: 'start' });
    expect(view(room, 'dev-a').you.catchphrase).toBeNull();
    expect(view(room, 'dev-a').you.hand).toHaveLength(HAND_SIZE);
    // Late joiners do not get one either.
    room = must(room, 'dev-c', hello('dev-c', 'Cy'));
    expect(room.game!.players.p3.catchphrase ?? null).toBeNull();

    // On by default.
    let on = must(lobby(), 'dev-a', { t: 'start' });
    expect(view(on, 'dev-a').you.catchphrase?.heat).toBe(1);
    expect(send(on, 'dev-a', { t: 'configure', options: { packs: ['core'], catchphrase: false } }).error?.code).toBe('wrong-phase');
  });

  it('"Failed" works on a phrase that was never started, names the catcher and pays a coin', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    const card = view(room, 'dev-a').you.hand[2];
    expect(card.saidAt).toBeNull();
    const out = send(room, 'dev-a', { t: 'caught', cardId: card.id, catcherId: 'p2' });
    expect(out.news).toEqual([{ kind: 'seized', name: 'Ada', by: 'Bo', text: card.text }]);
    expect(out.awards).toEqual([
      { memberId: 'p1', delta: { seized: 1 } },
      { memberId: 'p2', delta: { busts: 1 } },
    ]);
    room = out.room!;
    expect(view(room, 'dev-a').you.hand).toHaveLength(HAND_SIZE);
    expect(view(room, 'dev-b').you.swapCredits).toBe(1);
    // Nobody named: seized all the same, no coin for anyone.
    const again = send(room, 'dev-a', { t: 'caught', cardId: view(room, 'dev-a').you.hand[0].id });
    expect(again.news[0]).toMatchObject({ kind: 'seized', by: null });
    expect(view(again.room!, 'dev-b').you.swapCredits).toBe(1);
    // Naming yourself earns nothing.
    const self = send(room, 'dev-a', { t: 'caught', cardId: view(room, 'dev-a').you.hand[0].id, catcherId: 'p1' });
    expect(view(self.room!, 'dev-a').you.swapCredits).toBe(0);
  });

  it('lets a player change their name at any time, keeping names unique', () => {
    let room = lobby();
    let out = send(room, 'dev-b', { t: 'rename', name: '  Sticky   Pete ' });
    expect(out.news).toEqual([{ kind: 'renamed', from: 'Bo', name: 'Sticky Pete' }]);
    room = out.room!;
    expect(room.members[1].name).toBe('Sticky Pete');
    room = must(room, 'dev-c', { t: 'rename', name: 'ADA' });
    expect(room.members[2].name).toBe('ADA 2');
    room = must(room, 'dev-a', { t: 'start' });
    room = must(room, 'dev-b', { t: 'rename', name: 'Velvet Ferret With A Very Long Name' });
    expect(view(room, 'dev-a').players[1].name).toBe('Velvet Ferret Wi');
    out = send(room, 'dev-b', { t: 'rename', name: 'Velvet Ferret Wi' });
    expect(out.news).toEqual([]);
    expect(send(room, 'stranger', { t: 'rename', name: 'x' }).error?.code).toBe('not-in-room');
  });

  it('reports progress for each player as the game unfolds', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    const card = view(room, 'dev-a').you.hand[0];
    room = must(room, 'dev-a', { t: 'declare', cardId: card.id });
    room = must(room, 'dev-b', { t: 'accuse', accusedId: 'p1' }, T0 + 1000);
    let out = send(room, 'dev-a', { t: 'resolve', cardId: card.id }, T0 + 2000);
    expect(out.awards).toEqual([
      { memberId: 'p1', delta: { seized: 1 } },
      { memberId: 'p2', delta: { busts: 1 } },
    ]);
    room = must(out.room, 'dev-b', { t: 'swap', cardId: null });
    room = must(room, 'dev-c', { t: 'accuse', accusedId: 'p2' });
    out = send(room, 'dev-b', { t: 'resolve', cardId: null });
    expect(out.awards).toEqual([{ memberId: 'p3', delta: { wrongCalls: 1 } }]);
    room = out.room!;

    let now = T0 + 10_000;
    const hand = view(room, 'dev-b').you.hand;
    for (const c of hand) room = must(room, 'dev-b', { t: 'declare', cardId: c.id }, now);
    now += TIMER_MS;
    for (const c of hand.slice(0, -1)) {
      out = send(room, 'dev-b', { t: 'smuggle', cardId: c.id }, now);
      expect(out.awards).toEqual([{ memberId: 'p2', delta: { smuggled: 1 } }]);
      room = out.room!;
    }
    out = send(room, 'dev-b', { t: 'smuggle', cardId: hand[hand.length - 1].id }, now);
    expect(out.awards).toEqual([
      { memberId: 'p2', delta: { smuggled: 1, getaways: 1, games: 1 } },
      { memberId: 'p1', delta: { games: 1 } },
      { memberId: 'p3', delta: { games: 1 } },
    ]);
  });

  it('shows each device only its own phrases', () => {
    const room = must(lobby(), 'dev-a', { t: 'start' });
    const a = view(room, 'dev-a'), b = view(room, 'dev-b');
    expect(a.you.hand).toHaveLength(HAND_SIZE);
    expect(a.players.map((p) => p.cards)).toEqual([5, 5, 5]);
    const aText = JSON.stringify(a);
    for (const card of b.you.hand) expect(aText).not.toContain(card.text);
    expect(aText).not.toContain('dev-b');
    expect(viewFor(room, 'stranger', new Set())).toBeNull();
    expect(viewFor(room, 'dev-a', new Set(['dev-a']))!.players.map((p) => p.connected)).toEqual([true, false, false]);
  });

  it('lets a player own up to being caught, crediting whoever caught them', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    const [card, other] = view(room, 'dev-a').you.hand;
    room = must(room, 'dev-a', { t: 'declare', cardId: card.id });
    const out = send(room, 'dev-a', { t: 'caught', cardId: card.id, catcherId: 'p2' }, T0 + 4000);
    expect(out.news).toEqual([{ kind: 'seized', name: 'Ada', by: 'Bo', text: card.text }]);
    room = out.room!;
    expect(view(room, 'dev-a').you.hand).toHaveLength(HAND_SIZE);
    expect(view(room, 'dev-a').you.hand.some((c) => c.id === card.id)).toBe(false);
    expect(view(room, 'dev-a').you.seized).toBe(1);
    expect(view(room, 'dev-b').you.swapCredits).toBe(1);
    // You cannot name yourself to pocket the swap.
    room = must(room, 'dev-a', { t: 'declare', cardId: other.id }, T0 + 5000);
    room = must(room, 'dev-a', { t: 'caught', cardId: other.id, catcherId: 'p1' }, T0 + 6000);
    expect(view(room, 'dev-a').you.swapCredits).toBe(0);
    expect(view(room, 'dev-a').you.seized).toBe(2);
  });

  it('runs a full bust: accuse, confirm, swap', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    const card = view(room, 'dev-a').you.hand[0];
    room = must(room, 'dev-a', { t: 'declare', cardId: card.id });
    room = must(room, 'dev-b', { t: 'accuse', accusedId: view(room, 'dev-a').you.id }, T0 + 5000);
    expect(view(room, 'dev-c').accusation).toMatchObject({ callerId: 'p2', accusedId: 'p1' });
    expect(send(room, 'dev-c', { t: 'resolve', cardId: null }).error).toEqual({ code: 'rule', detail: 'not-accused' });

    const out = send(room, 'dev-a', { t: 'resolve', cardId: card.id }, T0 + 8000);
    expect(out.news).toEqual([{ kind: 'seized', name: 'Ada', by: 'Bo', text: card.text }]);
    room = out.room!;
    expect(view(room, 'dev-a').you.hand).toHaveLength(HAND_SIZE);
    expect(view(room, 'dev-b').you.swapCredits).toBe(1);
    const swapOut = view(room, 'dev-b').you.hand[0].id;
    room = must(room, 'dev-b', { t: 'swap', cardId: swapOut });
    expect(view(room, 'dev-b').you.hand.some((c) => c.id === swapOut)).toBe(false);
    expect(view(room, 'dev-b').you.swapCredits).toBe(0);
  });

  it('a denied call announces the penalty; the host can void a stuck call', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    room = must(room, 'dev-b', { t: 'accuse', accusedId: 'p3' });
    const out = send(room, 'dev-c', { t: 'resolve', cardId: null });
    expect(out.news).toEqual([{ kind: 'wrongCall', name: 'Bo', accused: 'Cy', badgesLeft: 2 }]);
    room = out.room!;
    expect(view(room, 'dev-a').players[1]).toMatchObject({ badges: 2, cards: 6 });

    room = must(room, 'dev-b', { t: 'accuse', accusedId: 'p3' });
    expect(send(room, 'dev-b', { t: 'cancelAccusation' }).error?.code).toBe('not-host');
    room = must(room, 'dev-a', { t: 'cancelAccusation' });
    expect(room.game!.accusation).toBeNull();
    expect(view(room, 'dev-a').players[1].badges).toBe(2);
  });

  it('announces the winner with their smuggled phrases to everyone', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    let now = T0;
    const said: string[] = [];
    for (const card of view(room, 'dev-b').you.hand) {
      room = must(room, 'dev-b', { t: 'declare', cardId: card.id }, now);
      expect(send(room, 'dev-b', { t: 'smuggle', cardId: card.id }, now + 1000).error?.detail).toBe('timer-running');
      now += TIMER_MS;
      room = must(room, 'dev-b', { t: 'smuggle', cardId: card.id }, now);
      said.push(card.text);
    }
    expect(room.phase).toBe('over');
    for (const dev of ['dev-a', 'dev-b', 'dev-c']) {
      const w = view(room, dev).winner!;
      expect(w.name).toBe('Bo');
      expect(w.phrases.map((p) => p.text)).toEqual(said);
    }
    expect(send(room, 'dev-a', { t: 'declare', cardId: 'x' }).error?.code).toBe('wrong-phase');
    room = must(room, 'dev-a', { t: 'again' });
    expect(room.phase).toBe('playing');
    expect(view(room, 'dev-b').winner).toBeNull();
    expect(view(room, 'dev-b').you.hand).toHaveLength(HAND_SIZE);
  });

  it('deals in late joiners, passes host on when the host leaves, closes when empty', () => {
    let room = must(lobby(), 'dev-a', { t: 'start' });
    room = must(room, 'dev-d', hello('dev-d', 'Dee'));
    expect(viewFor(room, 'dev-d', new Set())!.you.hand).toHaveLength(HAND_SIZE);

    const out = send(room, 'dev-a', { t: 'leave' });
    expect(out.drop).toEqual(['dev-a']);
    room = out.room!;
    expect(room.hostId).toBe('p2');
    expect(room.game!.players.p1).toBeUndefined();
    expect(send(room, 'dev-c', { t: 'kick', playerId: 'p2' }).error?.code).toBe('not-host');
    room = must(room, 'dev-b', { t: 'kick', playerId: 'p3' });
    room = must(room, 'dev-b', { t: 'kick', playerId: 'p4' });
    expect(send(room, 'dev-b', { t: 'leave' }).room).toBeNull();
  });
});
