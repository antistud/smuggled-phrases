import { describe, expect, it } from 'vitest';
import type { Phrase } from '../src/shared/packs';
import {
  addPlayer,
  applyAction,
  clockFor,
  createGame,
  HAND_SIZE,
  isCleared,
  isLive,
  remainingMs,
  removePlayer,
  STARTING_BADGES,
  TIMER_MS,
  type Action,
  type Game,
} from '../src/shared/rules';

const pile = (n: number): Phrase[] => Array.from({ length: n }, (_, i) => ({ id: `t:${i}`, text: `phrase ${i}`, heat: ((i % 3) + 1) as 1 | 2 | 3 }));
const T0 = 1_000_000;

function ok(game: Game, action: Action) {
  const r = applyAction(game, action);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r;
}
function err(game: Game, action: Action) {
  const r = applyAction(game, action);
  if (r.ok) throw new Error('expected an error');
  return r.error;
}
const allCardIds = (g: Game) => Object.values(g.players).flatMap((p) => p.hand.map((c) => c.id));

describe('setup', () => {
  it('deals 5 unique cards and 3 badges to each player', () => {
    const g = createGame(['a', 'b', 'c'], pile(40));
    for (const p of Object.values(g.players)) {
      expect(p.hand).toHaveLength(HAND_SIZE);
      expect(p.badges).toBe(STARTING_BADGES);
      expect(p.hand.every((c) => c.saidAt === null)).toBe(true);
    }
    expect(new Set(allCardIds(g)).size).toBe(15);
    expect(g.pile).toHaveLength(25);
    expect(g.pile.some((p) => allCardIds(g).includes(p.id))).toBe(false);
  });

  it('deals the chosen hand size, as one block per player, and remembers it for late joiners', () => {
    let g = createGame(['a', 'b'], pile(40), 7);
    expect(g.players.a.hand.map((c) => c.id)).toEqual(['t:0', 't:1', 't:2', 't:3', 't:4', 't:5', 't:6']);
    expect(g.players.b.hand.map((c) => c.id)).toEqual(['t:7', 't:8', 't:9', 't:10', 't:11', 't:12', 't:13']);
    g = addPlayer(g, 'c');
    expect(g.players.c.hand).toHaveLength(7);
    expect(createGame(['a'], pile(40), 3).players.a.hand).toHaveLength(3);
  });

  it('deals a late joiner in from the pile and can remove a player', () => {
    let g = createGame(['a', 'b'], pile(40));
    g = addPlayer(g, 'c');
    expect(g.players.c.hand).toHaveLength(HAND_SIZE);
    expect(new Set(allCardIds(g)).size).toBe(15);
    expect(addPlayer(g, 'c')).toBe(g);
    g = ok(g, { type: 'accuse', playerId: 'a', accusedId: 'c', now: T0 }).game;
    g = removePlayer(g, 'c');
    expect(g.players.c).toBeUndefined();
    expect(g.accusation).toBeNull();
  });

  it('never mutates the game it is given', () => {
    const g = createGame(['a', 'b'], pile(40));
    const before = JSON.stringify(g);
    ok(g, { type: 'declare', playerId: 'a', cardId: g.players.a.hand[0].id, now: T0 });
    expect(JSON.stringify(g)).toBe(before);
  });
});

describe('saying a phrase (rules 2 and 3)', () => {
  it('starts a 30 second countdown from the stored timestamp', () => {
    let g = createGame(['a', 'b'], pile(40));
    const id = g.players.a.hand[2].id;
    g = ok(g, { type: 'declare', playerId: 'a', cardId: id, now: T0 }).game;
    const card = g.players.a.hand[2];
    expect(card.saidAt).toBe(T0);
    expect(remainingMs(card, T0 + 12_000)).toBe(18_000);
    expect(isLive(card, T0 + TIMER_MS - 1)).toBe(true);
    expect(isLive(card, T0 + TIMER_MS)).toBe(false);
    expect(isCleared(card, T0 + TIMER_MS)).toBe(true);
    expect(remainingMs(card, T0 + 999_999)).toBe(0);
  });

  it('cannot clear a card before 30 seconds are up', () => {
    let g = createGame(['a', 'b'], pile(40));
    const id = g.players.a.hand[0].id;
    expect(err(g, { type: 'smuggle', playerId: 'a', cardId: id, now: T0 })).toBe('not-declared');
    g = ok(g, { type: 'declare', playerId: 'a', cardId: id, now: T0 }).game;
    expect(err(g, { type: 'declare', playerId: 'a', cardId: id, now: T0 + 5 })).toBe('already-declared');
    expect(err(g, { type: 'smuggle', playerId: 'a', cardId: id, now: T0 + TIMER_MS - 1 })).toBe('timer-running');
  });

  it('clears the card with no replacement once the timer is done', () => {
    let g = createGame(['a', 'b'], pile(40));
    const card = g.players.a.hand[0];
    g = ok(g, { type: 'declare', playerId: 'a', cardId: card.id, now: T0 }).game;
    const r = ok(g, { type: 'smuggle', playerId: 'a', cardId: card.id, now: T0 + TIMER_MS });
    expect(r.game.players.a.hand).toHaveLength(HAND_SIZE - 1);
    expect(r.game.players.a.smuggled).toEqual([{ id: card.id, text: card.text, heat: card.heat }]);
    expect(r.game.pile).toHaveLength(g.pile.length);
    expect(r.events).toContainEqual({ type: 'smuggled', playerId: 'a', phrase: { id: card.id, text: card.text, heat: card.heat } });
  });

  it('lets a mis-tap be undone', () => {
    let g = createGame(['a', 'b'], pile(40));
    const id = g.players.a.hand[0].id;
    expect(err(g, { type: 'undeclare', playerId: 'a', cardId: id })).toBe('not-declared');
    g = ok(g, { type: 'declare', playerId: 'a', cardId: id, now: T0 }).game;
    g = ok(g, { type: 'undeclare', playerId: 'a', cardId: id }).game;
    expect(g.players.a.hand[0].saidAt).toBeNull();
  });

  it('rejects unknown players and cards', () => {
    const g = createGame(['a', 'b'], pile(40));
    expect(err(g, { type: 'declare', playerId: 'zz', cardId: 'x', now: T0 })).toBe('no-such-player');
    expect(err(g, { type: 'declare', playerId: 'a', cardId: g.players.b.hand[0].id, now: T0 })).toBe('no-such-card');
  });
});

describe('honor-system outcomes (offline mode)', () => {
  it('caught: the phrase is seized and replaced in the same slot (rule 5)', () => {
    let g = createGame(['me'], pile(20));
    const card = g.players.me.hand[1];
    const nextUp = g.pile[0];
    expect(err(g, { type: 'caught', playerId: 'me', cardId: card.id })).toBe('not-declared');
    g = ok(g, { type: 'declare', playerId: 'me', cardId: card.id, now: T0 }).game;
    g = ok(g, { type: 'caught', playerId: 'me', cardId: card.id }).game;
    expect(g.players.me.hand).toHaveLength(HAND_SIZE);
    expect(g.players.me.hand[1]).toEqual({ ...nextUp, saidAt: null });
    expect(g.players.me.seized.map((p) => p.id)).toEqual([card.id]);
    expect(g.players.me.smuggled).toEqual([]);
  });

  it('catcher may swap one phrase, or decline (rule 5)', () => {
    let g = createGame(['me'], pile(20));
    const first = g.players.me.hand[0];
    expect(err(g, { type: 'swap', playerId: 'me', cardId: first.id })).toBe('no-swap');
    g = ok(g, { type: 'grantSwap', playerId: 'me' }).game;
    const nextUp = g.pile[0];
    g = ok(g, { type: 'swap', playerId: 'me', cardId: first.id }).game;
    expect(g.players.me.hand[0].id).toBe(nextUp.id);
    expect(g.players.me.hand).toHaveLength(HAND_SIZE);
    expect(g.players.me.swapCredits).toBe(0);

    g = ok(g, { type: 'grantSwap', playerId: 'me' }).game;
    const before = g.players.me.hand.map((c) => c.id);
    g = ok(g, { type: 'swap', playerId: 'me', cardId: null }).game;
    expect(g.players.me.hand.map((c) => c.id)).toEqual(before);
    expect(g.players.me.swapCredits).toBe(0);
  });

  it('cannot swap away a card whose timer is running', () => {
    let g = createGame(['me'], pile(20));
    const id = g.players.me.hand[0].id;
    g = ok(g, { type: 'declare', playerId: 'me', cardId: id, now: T0 }).game;
    g = ok(g, { type: 'grantSwap', playerId: 'me' }).game;
    expect(err(g, { type: 'swap', playerId: 'me', cardId: id })).toBe('card-in-play');
  });

  it('wrong call: draw an extra phrase and lose a badge; no badges, no calls (rule 6)', () => {
    let g = createGame(['me'], pile(20));
    for (let i = 1; i <= STARTING_BADGES; i++) {
      g = ok(g, { type: 'wrongCall', playerId: 'me' }).game;
      expect(g.players.me.badges).toBe(STARTING_BADGES - i);
      expect(g.players.me.hand).toHaveLength(HAND_SIZE + i);
    }
    expect(err(g, { type: 'wrongCall', playerId: 'me' })).toBe('no-badges');
    expect(err(g, { type: 'grantSwap', playerId: 'me' })).toBe('no-badges');
    expect(new Set(g.players.me.hand.map((c) => c.id)).size).toBe(HAND_SIZE + STARTING_BADGES);
  });
});

describe('Contraband! calls (synced rooms)', () => {
  function live() {
    let g = createGame(['a', 'b', 'c'], pile(60));
    const card = g.players.a.hand[0];
    g = ok(g, { type: 'declare', playerId: 'a', cardId: card.id, now: T0 }).game;
    return { g, card };
  }

  it('a correct call seizes and replaces the phrase and earns the caller a swap', () => {
    const { g: g0, card } = live();
    let g = ok(g0, { type: 'accuse', playerId: 'b', accusedId: 'a', now: T0 + 10_000 }).game;
    expect(g.accusation).toEqual({ callerId: 'b', accusedId: 'a', at: T0 + 10_000 });
    const r = ok(g, { type: 'resolve', playerId: 'a', cardId: card.id, now: T0 + 15_000 });
    g = r.game;
    expect(g.accusation).toBeNull();
    expect(g.players.a.hand).toHaveLength(HAND_SIZE);
    expect(g.players.a.hand.some((c) => c.id === card.id)).toBe(false);
    expect(g.players.a.seized.map((p) => p.id)).toEqual([card.id]);
    expect(g.players.b.swapCredits).toBe(1);
    expect(g.players.b.badges).toBe(STARTING_BADGES);
    expect(r.events[0]).toMatchObject({ type: 'seized', playerId: 'a', catcherId: 'b' });

    const swapOut = g.players.b.hand[3].id;
    g = ok(g, { type: 'swap', playerId: 'b', cardId: swapOut }).game;
    expect(g.players.b.hand).toHaveLength(HAND_SIZE);
    expect(g.players.b.hand.some((c) => c.id === swapOut)).toBe(false);
    expect(new Set(allCardIds(g)).size).toBe(15);
  });

  it('a wrong call costs the caller a badge and an extra phrase', () => {
    const { g: g0 } = live();
    let g = ok(g0, { type: 'accuse', playerId: 'b', accusedId: 'c', now: T0 + 1000 }).game;
    const r = ok(g, { type: 'resolve', playerId: 'c', cardId: null, now: T0 + 2000 });
    g = r.game;
    expect(g.players.b.badges).toBe(STARTING_BADGES - 1);
    expect(g.players.b.hand).toHaveLength(HAND_SIZE + 1);
    expect(g.players.b.swapCredits).toBe(0);
    expect(g.players.c.hand).toHaveLength(HAND_SIZE);
    expect(r.events).toContainEqual({ type: 'wrongCall', playerId: 'b', accusedId: 'c', badgesLeft: 2 });
  });

  it('a player with no badges cannot call anyone', () => {
    let { g } = live();
    for (let i = 0; i < STARTING_BADGES; i++) {
      g = ok(g, { type: 'accuse', playerId: 'b', accusedId: 'c', now: T0 + i }).game;
      g = ok(g, { type: 'resolve', playerId: 'c', cardId: null, now: T0 + i }).game;
    }
    expect(g.players.b.badges).toBe(0);
    expect(err(g, { type: 'accuse', playerId: 'b', accusedId: 'a', now: T0 + 50 })).toBe('no-badges');
  });

  it('only the accused can answer, one call at a time, never yourself', () => {
    const { g: g0, card } = live();
    expect(err(g0, { type: 'accuse', playerId: 'b', accusedId: 'b', now: T0 })).toBe('self-accuse');
    expect(err(g0, { type: 'resolve', playerId: 'a', cardId: null, now: T0 })).toBe('no-accusation');
    const g = ok(g0, { type: 'accuse', playerId: 'b', accusedId: 'a', now: T0 + 1 }).game;
    expect(err(g, { type: 'accuse', playerId: 'c', accusedId: 'a', now: T0 + 2 })).toBe('accusation-pending');
    expect(err(g, { type: 'resolve', playerId: 'c', cardId: card.id, now: T0 + 2 })).toBe('not-accused');
    expect(err(g, { type: 'resolve', playerId: 'a', cardId: g.players.a.hand[1].id, now: T0 + 2 })).toBe('not-declared');
  });

  it('a call that lands after the 30 seconds cannot seize the card', () => {
    const { g: g0, card } = live();
    const g = ok(g0, { type: 'accuse', playerId: 'b', accusedId: 'a', now: T0 + TIMER_MS + 1 }).game;
    expect(err(g, { type: 'resolve', playerId: 'a', cardId: card.id, now: T0 + TIMER_MS + 500 })).toBe('timer-expired');
    // ...and the accused may still clear it while the call is pending.
    const r = ok(g, { type: 'smuggle', playerId: 'a', cardId: card.id, now: T0 + TIMER_MS + 600 });
    expect(r.game.players.a.smuggled).toHaveLength(1);
  });

  it('stops the accused clock during a call and gives the time back after a denial', () => {
    const { g: g0, card } = live();
    let g = ok(g0, { type: 'accuse', playerId: 'b', accusedId: 'a', now: T0 + 10_000 }).game;
    // 40s later the argument is still going: the card must not be clearable.
    expect(clockFor(g, 'a', T0 + 50_000)).toBe(T0 + 10_000);
    expect(clockFor(g, 'c', T0 + 50_000)).toBe(T0 + 50_000);
    expect(err(g, { type: 'smuggle', playerId: 'a', cardId: card.id, now: T0 + 50_000 })).toBe('accusation-pending');
    expect(err(g, { type: 'declare', playerId: 'a', cardId: g.players.a.hand[1].id, now: T0 + 50_000 })).toBe('accusation-pending');

    g = ok(g, { type: 'resolve', playerId: 'a', cardId: null, now: T0 + 50_000 }).game;
    const after = g.players.a.hand.find((c) => c.id === card.id)!;
    expect(remainingMs(after, T0 + 50_000)).toBe(20_000);
    expect(err(g, { type: 'smuggle', playerId: 'a', cardId: card.id, now: T0 + 69_999 })).toBe('timer-running');
    ok(g, { type: 'smuggle', playerId: 'a', cardId: card.id, now: T0 + 70_000 });
  });

  it('a voided call has no penalty and also restores the clock', () => {
    const { g: g0, card } = live();
    let g = ok(g0, { type: 'accuse', playerId: 'b', accusedId: 'a', now: T0 + 5000 }).game;
    g = ok(g, { type: 'cancelAccusation', now: T0 + 9000 }).game;
    expect(g.accusation).toBeNull();
    expect(g.players.b.badges).toBe(STARTING_BADGES);
    expect(g.players.b.hand).toHaveLength(HAND_SIZE);
    expect(g.players.a.hand.find((c) => c.id === card.id)!.saidAt).toBe(T0 + 4000);
  });
});

describe('winning (rule 7)', () => {
  it('the first empty hand wins and the game locks', () => {
    let g = createGame(['a', 'b'], pile(40));
    let now = T0;
    const events = [];
    for (const card of g.players.a.hand) {
      g = ok(g, { type: 'declare', playerId: 'a', cardId: card.id, now }).game;
      now += TIMER_MS;
      const r = ok(g, { type: 'smuggle', playerId: 'a', cardId: card.id, now });
      g = r.game;
      events.push(...r.events);
    }
    expect(g.winnerId).toBe('a');
    expect(g.players.a.smuggled).toHaveLength(HAND_SIZE);
    expect(events.filter((e) => e.type === 'won')).toEqual([{ type: 'won', playerId: 'a' }]);
    expect(err(g, { type: 'declare', playerId: 'b', cardId: g.players.b.hand[0].id, now })).toBe('game-over');
  });

  it('getting caught does not shrink the hand, so it cannot win', () => {
    let g = createGame(['a', 'b'], pile(40));
    for (let i = 0; i < 8; i++) {
      const id = g.players.a.hand[0].id;
      g = ok(g, { type: 'declare', playerId: 'a', cardId: id, now: T0 }).game;
      g = ok(g, { type: 'caught', playerId: 'a', cardId: id, catcherId: 'b' }).game;
    }
    expect(g.players.a.hand).toHaveLength(HAND_SIZE);
    expect(g.players.b.swapCredits).toBe(8);
    expect(g.winnerId).toBeNull();
  });

  it('an empty pile is handled: no replacement, no crash', () => {
    let g = createGame(['a'], pile(HAND_SIZE));
    expect(g.pile).toHaveLength(0);
    g = ok(g, { type: 'wrongCall', playerId: 'a' }).game;
    expect(g.players.a.hand).toHaveLength(HAND_SIZE);
    g = ok(g, { type: 'grantSwap', playerId: 'a' }).game;
    expect(err(g, { type: 'swap', playerId: 'a', cardId: g.players.a.hand[0].id })).toBe('pile-empty');
  });
});
