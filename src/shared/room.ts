/**
 * Room logic for synced games: who is in the room, who hosts, and how client
 * messages map onto the shared rules engine. Pure: the Durable Object in
 * worker/ only adds sockets and storage around these functions.
 */
import { buildDeck, normalizePackIds, TIERS, type Phrase, type TieredDeck } from './packs';
import { shuffle } from './prng';
import {
  MAX_NAME_LENGTH,
  MAX_ROOM_PLAYERS,
  type Announcement,
  type ClientMessage,
  type RoomPhase,
  type RoomView,
  type ServerErrorCode,
} from './protocol';
import type { StatDelta } from './account';
import { cleanName } from './names';
import { mixPile, normalizeSettings, type GameSettings } from './settings';
import { addPlayer, applyAction, createGame, removePlayer, type Action, type Game, type GameEvent } from './rules';

export interface Member {
  /** Public id, shown to other players. */
  id: string;
  /** Private per-device id. Never sent to anyone else. */
  deviceId: string;
  name: string;
  /** Account key, set by the server once it has verified the player's sign-in. */
  account?: string;
}

export interface Room {
  code: string;
  phase: RoomPhase;
  hostId: string;
  packs: string[];
  settings: GameSettings;
  members: Member[];
  game: Game | null;
  /** Monotonic counter for public ids. */
  seq: number;
}

export interface Outcome {
  /** null means the room no longer exists for this device (left or kicked) or was never created. */
  room: Room | null;
  news: Announcement[];
  error?: { code: ServerErrorCode; detail?: string };
  /** Device ids to disconnect after this message. */
  drop?: string[];
  /** Changes to players' lifetime records, by public member id. */
  awards?: { memberId: string; delta: StatDelta }[];
}

function uniqueName(room: Room, wanted: string, exceptId?: string): string {
  const taken = new Set(room.members.filter((m) => m.id !== exceptId).map((m) => m.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted.slice(0, MAX_NAME_LENGTH - 2)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function memberOf(room: Room, deviceId: string): Member | undefined {
  return room.members.find((m) => m.deviceId === deviceId);
}

function nameOf(room: Room, id: string | null | undefined): string | null {
  return room.members.find((m) => m.id === id)?.name ?? null;
}

/** A new server-side pile: every tier shuffled, then woven to the room's spiciness. */
function freshPile(room: Room, rand: () => number): Phrase[] {
  const deck = buildDeck(room.packs);
  const shuffled = {} as TieredDeck;
  for (const tier of TIERS) shuffled[tier] = shuffle(deck[tier], rand);
  return mixPile(shuffled, room.settings.spice, rand);
}

/** What a batch of game events adds to each player's lifetime record. */
export function toAwards(game: Game, events: GameEvent[]): { memberId: string; delta: StatDelta }[] {
  const totals = new Map<string, StatDelta>();
  const add = (memberId: string | null | undefined, key: keyof StatDelta) => {
    if (!memberId) return;
    const delta = totals.get(memberId) ?? {};
    delta[key] = (delta[key] ?? 0) + 1;
    totals.set(memberId, delta);
  };
  for (const e of events) {
    if (e.type === 'smuggled') add(e.playerId, 'smuggled');
    if (e.type === 'seized') {
      add(e.playerId, 'seized');
      add(e.catcherId, 'busts');
    }
    if (e.type === 'wrongCall') add(e.playerId, 'wrongCalls');
    if (e.type === 'won') {
      add(e.playerId, 'getaways');
      for (const id of Object.keys(game.players)) add(id, 'games');
    }
  }
  return [...totals].map(([memberId, delta]) => ({ memberId, delta }));
}

function toNews(room: Room, events: GameEvent[]): Announcement[] {
  const news: Announcement[] = [];
  for (const e of events) {
    if (e.type === 'smuggled') news.push({ kind: 'smuggled', name: nameOf(room, e.playerId) ?? '?', text: e.phrase.text });
    if (e.type === 'seized') {
      news.push({ kind: 'seized', name: nameOf(room, e.playerId) ?? '?', by: nameOf(room, e.catcherId), text: e.phrase.text });
    }
    if (e.type === 'catchphrase') news.push({ kind: 'catchphrase', name: nameOf(room, e.playerId) ?? '?', text: e.phrase.text, count: e.count });
    if (e.type === 'catchphraseCaught') {
      news.push({ kind: 'catchphraseCaught', name: nameOf(room, e.playerId) ?? '?', by: nameOf(room, e.catcherId), text: e.phrase.text });
    }
    if (e.type === 'wrongCall') {
      news.push({ kind: 'wrongCall', name: nameOf(room, e.playerId) ?? '?', accused: nameOf(room, e.accusedId), badgesLeft: e.badgesLeft });
    }
    if (e.type === 'accusationCancelled') news.push({ kind: 'cancelled' });
  }
  return news;
}

/**
 * Applies one client message. `room` is null when the room does not exist yet.
 * `rand` is only used to shuffle a new deck.
 */
export function handleMessage(
  room: Room | null,
  deviceId: string,
  msg: ClientMessage,
  now: number,
  rand: () => number,
  code: string,
): Outcome {
  const fail = (c: ServerErrorCode, detail?: string): Outcome => ({ room, news: [], error: { code: c, detail } });

  if (msg.t === 'hello') {
    const name = cleanName(msg.name);
    if (!room) {
      if (!msg.create) return fail('room-not-found');
      const host: Member = { id: 'p1', deviceId, name };
      return {
        room: {
          code,
          phase: 'lobby',
          hostId: host.id,
          packs: normalizePackIds(msg.create.packs ?? []),
          settings: normalizeSettings(msg.create),
          members: [host],
          game: null,
          seq: 1,
        },
        news: [],
      };
    }
    const existing = memberOf(room, deviceId);
    if (existing) {
      // Reconnect (or the host's create retry). Keep the seat, refresh the name.
      const next = structuredCloneRoom(room);
      memberOf(next, deviceId)!.name = uniqueName(next, name, existing.id);
      return { room: next, news: [] };
    }
    if (msg.create) return fail('room-taken');
    if (room.members.length >= MAX_ROOM_PLAYERS) return fail('room-full');
    const next = structuredCloneRoom(room);
    next.seq += 1;
    const member: Member = { id: `p${next.seq}`, deviceId, name: uniqueName(next, name) };
    next.members.push(member);
    // Late arrivals are dealt in from the same pile.
    if (next.phase === 'playing' && next.game) next.game = addPlayer(next.game, member.id);
    return { room: next, news: [{ kind: 'joined', name: member.name }] };
  }

  if (!room) return fail('room-not-found');
  const me = memberOf(room, deviceId);
  if (!me) return fail('not-in-room');
  const isHost = me.id === room.hostId;

  const play = (action: Action): Outcome => {
    if (room.phase !== 'playing' || !room.game) return fail('wrong-phase');
    const result = applyAction(room.game, action);
    if (!result.ok) return fail('rule', result.error);
    const next = structuredCloneRoom(room);
    next.game = result.game;
    if (result.game.winnerId) next.phase = 'over';
    return { room: next, news: toNews(next, result.events), awards: toAwards(result.game, result.events) };
  };

  switch (msg.t) {
    case 'start':
    case 'again': {
      if (!isHost) return fail('not-host');
      if (msg.t === 'start' && room.phase !== 'lobby') return fail('wrong-phase');
      if (room.members.length < 2) return fail('need-players');
      const next = structuredCloneRoom(room);
      next.game = createGame(next.members.map((m) => m.id), freshPile(next, rand), next.settings.handSize);
      next.phase = 'playing';
      return { room: next, news: [] };
    }
    case 'rename': {
      const next = structuredCloneRoom(room);
      const member = memberOf(next, deviceId)!;
      const before = member.name;
      member.name = uniqueName(next, cleanName(msg.name), member.id);
      return { room: next, news: member.name === before ? [] : [{ kind: 'renamed', from: before, name: member.name }] };
    }
    case 'configure': {
      if (!isHost) return fail('not-host');
      if (room.phase === 'playing') return fail('wrong-phase');
      const next = structuredCloneRoom(room);
      next.packs = normalizePackIds(msg.options?.packs ?? room.packs);
      next.settings = normalizeSettings({ ...room.settings, ...msg.options });
      return { room: next, news: [] };
    }
    case 'declare':
      return play({ type: 'declare', playerId: me.id, cardId: msg.cardId, now });
    case 'undeclare':
      return play({ type: 'undeclare', playerId: me.id, cardId: msg.cardId });
    case 'smuggle':
      return play({ type: 'smuggle', playerId: me.id, cardId: msg.cardId, now });
    case 'caught': {
      // Nobody can award themselves the catcher's swap.
      const catcherId = typeof msg.catcherId === 'string' && msg.catcherId !== me.id ? msg.catcherId : undefined;
      return play({ type: 'caught', playerId: me.id, cardId: msg.cardId, catcherId });
    }
    case 'accuse':
      return play({ type: 'accuse', playerId: me.id, accusedId: msg.accusedId, now });
    case 'resolve':
      return play({ type: 'resolve', playerId: me.id, cardId: msg.cardId, now });
    case 'swap':
      return play({ type: 'swap', playerId: me.id, cardId: msg.cardId });
    case 'cancelAccusation': {
      // The host can void a call, e.g. when the accused's phone has died.
      if (!isHost) return fail('not-host');
      return play({ type: 'cancelAccusation', now });
    }
    case 'kick':
    case 'leave': {
      const targetId = msg.t === 'kick' ? msg.playerId : me.id;
      if (msg.t === 'kick' && !isHost) return fail('not-host');
      const target = room.members.find((m) => m.id === targetId);
      if (!target) return fail('not-in-room');
      const next = structuredCloneRoom(room);
      next.members = next.members.filter((m) => m.id !== targetId);
      if (next.game) next.game = removePlayer(next.game, targetId);
      const drop = [target.deviceId];
      if (next.members.length === 0) return { room: null, news: [], drop };
      if (next.hostId === targetId) next.hostId = next.members[0].id;
      return { room: next, news: [{ kind: 'left', name: target.name }], drop };
    }
  }
}

function structuredCloneRoom(room: Room): Room {
  return JSON.parse(JSON.stringify(room)) as Room;
}

/** What one device is allowed to see: everyone's counts, only its own phrases. */
export function viewFor(room: Room, deviceId: string, connected: ReadonlySet<string>): RoomView | null {
  const me = memberOf(room, deviceId);
  if (!me) return null;
  const game = room.game;
  const mine = game?.players[me.id];
  const winnerId = game?.winnerId ?? null;
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    packs: room.packs,
    settings: room.settings,
    pileCount: game?.pile.length ?? 0,
    players: room.members.map((m) => {
      const p = game?.players[m.id];
      return {
        id: m.id,
        name: m.name,
        connected: connected.has(m.deviceId),
        cards: p?.hand.length ?? 0,
        badges: p?.badges ?? 0,
        smuggled: p?.smuggled.length ?? 0,
        seized: p?.seized.length ?? 0,
        catchCount: p?.catchCount ?? 0,
      };
    }),
    you: {
      id: me.id,
      hand: mine?.hand ?? [],
      badges: mine?.badges ?? 0,
      swapCredits: mine?.swapCredits ?? 0,
      smuggled: mine?.smuggled ?? [],
      seized: mine?.seized.length ?? 0,
      catchphrase: mine?.catchphrase ?? null,
      catchCount: mine?.catchCount ?? 0,
    },
    accusation: game?.accusation ?? null,
    winner: winnerId
      ? { id: winnerId, name: nameOf(room, winnerId) ?? '?', phrases: game!.players[winnerId]?.smuggled ?? [] }
      : null,
  };
}
