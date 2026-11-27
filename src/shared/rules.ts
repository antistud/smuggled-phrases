/**
 * Smuggled Phrases rules engine.
 *
 * Pure and deterministic: every function takes a game and returns a new one.
 * No clocks, no randomness, no I/O. Callers pass `now` in and supply an already
 * shuffled draw pile. Offline mode runs it with one player and that player's
 * stripe of the deck; the room server runs it with every player and one pile.
 */
import type { Phrase } from './packs';

/** Default starting hand; a game can choose its own (see settings.ts). */
export const HAND_SIZE = 5;
export const TIMER_MS = 30_000;
export const STARTING_BADGES = 3;

export interface Card extends Phrase {
  /** Epoch ms when the player tapped "I said it", or null if still hidden. */
  saidAt: number | null;
}

export interface Player {
  id: string;
  hand: Card[];
  badges: number;
  /** Phrases this player got away with, in order. */
  smuggled: Phrase[];
  /** Phrases this player had seized. */
  seized: Phrase[];
  /** Bounty coins: earned by catching someone, each buys one phrase swap whenever the player likes. */
  swapCredits: number;
}

/** A "Contraband!" call waiting for the accused to confirm or deny (synced rooms). */
export interface Accusation {
  callerId: string;
  accusedId: string;
  at: number;
}

export interface Game {
  /** Phrases each player starts with (also used to deal in late joiners). */
  handSize: number;
  players: Record<string, Player>;
  /** Draw pile; index 0 is the next card. */
  pile: Phrase[];
  accusation: Accusation | null;
  winnerId: string | null;
}

export type Action =
  /** Rule 2: phrase spoken, start its 30 second countdown. */
  | { type: 'declare'; playerId: string; cardId: string; now: number }
  /** Mis-tap: put a counting card back in the hand. */
  | { type: 'undeclare'; playerId: string; cardId: string }
  /** Rule 3: countdown survived, clear the card. */
  | { type: 'smuggle'; playerId: string; cardId: string; now: number }
  /**
   * Rule 5, owned up to by the player ("Failed"): this card was caught. It need
   * not be counting: people get caught before they reach the button. The
   * optional catcher earns a bounty coin (a swap credit).
   */
  | { type: 'caught'; playerId: string; cardId: string; catcherId?: string }
  /** Rule 5, honor system: this player caught someone and may swap. */
  | { type: 'grantSwap'; playerId: string }
  /** Rule 5: use (cardId) or waive (null) an earned swap. */
  | { type: 'swap'; playerId: string; cardId: string | null }
  /** Rule 6, honor system: this player called wrong. */
  | { type: 'wrongCall'; playerId: string }
  /** Rule 4, synced: playerId calls "Contraband!" on accusedId. */
  | { type: 'accuse'; playerId: string; accusedId: string; now: number }
  /** Synced: the accused confirms which card was caught (cardId) or denies (null). */
  | { type: 'resolve'; playerId: string; cardId: string | null; now: number }
  /** Synced: void a pending call with no penalty (e.g. the accused went offline). */
  | { type: 'cancelAccusation'; now: number };

export type GameEvent =
  | { type: 'declared'; playerId: string }
  | { type: 'smuggled'; playerId: string; phrase: Phrase }
  | { type: 'seized'; playerId: string; catcherId: string | null; phrase: Phrase }
  | { type: 'wrongCall'; playerId: string; accusedId: string | null; badgesLeft: number }
  | { type: 'swapped'; playerId: string }
  | { type: 'accused'; playerId: string; accusedId: string }
  | { type: 'accusationCancelled' }
  | { type: 'won'; playerId: string };

export type RuleError =
  | 'game-over'
  | 'no-such-player'
  | 'no-such-card'
  | 'already-declared'
  | 'not-declared'
  | 'timer-running'
  | 'timer-expired'
  | 'no-badges'
  | 'no-swap'
  | 'card-in-play'
  | 'pile-empty'
  | 'accusation-pending'
  | 'no-accusation'
  | 'not-accused'
  | 'self-accuse';

export type Result =
  | { ok: true; game: Game; events: GameEvent[] }
  | { ok: false; error: RuleError };

// ---------------------------------------------------------------- helpers

export function isDeclared(card: Card): boolean {
  return card.saidAt !== null;
}

/** Milliseconds left on a card's countdown at `now` (0 when done or not declared). */
export function remainingMs(card: Card, now: number): number {
  if (card.saidAt === null) return 0;
  return Math.max(0, TIMER_MS - (now - card.saidAt));
}

/** True while the countdown is running: the window in which it can be called. */
export function isLive(card: Card, now: number): boolean {
  return card.saidAt !== null && now - card.saidAt < TIMER_MS;
}

/** True once the countdown has fully elapsed and the card can be cleared. */
export function isCleared(card: Card, now: number): boolean {
  return card.saidAt !== null && now - card.saidAt >= TIMER_MS;
}

export function canCall(player: Player): boolean {
  return player.badges > 0;
}

function newPlayer(id: string): Player {
  return { id, hand: [], badges: STARTING_BADGES, smuggled: [], seized: [], swapCredits: 0 };
}

function clone(game: Game): Game {
  return JSON.parse(JSON.stringify(game)) as Game;
}

function toPhrase(p: Phrase): Phrase {
  return { id: p.id, text: p.text, heat: p.heat };
}

function draw(game: Game): Card | null {
  const next = game.pile.shift();
  return next ? { ...toPhrase(next), saidAt: null } : null;
}

function checkWin(game: Game, playerId: string, events: GameEvent[]): void {
  if (game.winnerId === null && game.players[playerId].hand.length === 0) {
    game.winnerId = playerId;
    game.accusation = null;
    events.push({ type: 'won', playerId });
  }
}

/** Seizes a card and deals its replacement into the same slot. */
function seize(game: Game, player: Player, index: number): Phrase {
  const [card] = player.hand.splice(index, 1);
  const phrase = toPhrase(card);
  player.seized.push(phrase);
  const replacement = draw(game);
  if (replacement) player.hand.splice(index, 0, replacement);
  return phrase;
}

function penalise(game: Game, caller: Player): void {
  caller.badges = Math.max(0, caller.badges - 1);
  const extra = draw(game);
  if (extra) caller.hand.push(extra);
}

// ------------------------------------------------------------------ setup

/**
 * Deals `handSize` consecutive cards to each player from the top of `pile`.
 * Hands are dealt as whole blocks (not one card at a time around the table) so
 * each one keeps the difficulty blend the pile was mixed with.
 */
export function createGame(playerIds: readonly string[], pile: readonly Phrase[], handSize: number = HAND_SIZE): Game {
  const game: Game = { handSize, players: {}, pile: pile.map(toPhrase), accusation: null, winnerId: null };
  for (const id of playerIds) {
    const player = newPlayer(id);
    for (let i = 0; i < handSize; i++) {
      const card = draw(game);
      if (card) player.hand.push(card);
    }
    game.players[id] = player;
  }
  return game;
}

/** Adds a late joiner with a fresh hand. No-op if they are already in. */
export function addPlayer(game: Game, playerId: string): Game {
  if (game.players[playerId]) return game;
  const next = clone(game);
  const player = newPlayer(playerId);
  for (let i = 0; i < (next.handSize ?? HAND_SIZE); i++) {
    const card = draw(next);
    if (card) player.hand.push(card);
  }
  next.players[playerId] = player;
  return next;
}

/** Removes a player; their cards leave the game. Voids any call involving them. */
export function removePlayer(game: Game, playerId: string): Game {
  if (!game.players[playerId]) return game;
  const next = clone(game);
  delete next.players[playerId];
  const a = next.accusation;
  if (a && (a.callerId === playerId || a.accusedId === playerId)) next.accusation = null;
  return next;
}

// ---------------------------------------------------------------- reducer

export function applyAction(current: Game, action: Action): Result {
  if (current.winnerId !== null) return { ok: false, error: 'game-over' };
  const game = clone(current);
  const events: GameEvent[] = [];
  const fail = (error: RuleError): Result => ({ ok: false, error });
  const done = (): Result => ({ ok: true, game, events });

  if (action.type === 'cancelAccusation') {
    if (!game.accusation) return fail('no-accusation');
    resumeTimers(game, game.accusation, action.now);
    game.accusation = null;
    events.push({ type: 'accusationCancelled' });
    return done();
  }

  const player = game.players[action.playerId];
  if (!player) return fail('no-such-player');
  const findCard = (cardId: string) => player.hand.findIndex((c) => c.id === cardId);
  const accusedNow = game.accusation?.accusedId === player.id;

  switch (action.type) {
    case 'declare': {
      const i = findCard(action.cardId);
      if (i < 0) return fail('no-such-card');
      if (accusedNow) return fail('accusation-pending');
      if (isDeclared(player.hand[i])) return fail('already-declared');
      player.hand[i].saidAt = action.now;
      events.push({ type: 'declared', playerId: player.id });
      return done();
    }

    case 'undeclare': {
      const i = findCard(action.cardId);
      if (i < 0) return fail('no-such-card');
      if (accusedNow) return fail('accusation-pending');
      if (!isDeclared(player.hand[i])) return fail('not-declared');
      player.hand[i].saidAt = null;
      return done();
    }

    case 'smuggle': {
      const i = findCard(action.cardId);
      if (i < 0) return fail('no-such-card');
      const card = player.hand[i];
      if (!isDeclared(card)) return fail('not-declared');
      // While a call against this player is pending their clocks are stopped.
      if (accusedNow && !isCleared(card, game.accusation!.at)) return fail('accusation-pending');
      if (!isCleared(card, action.now)) return fail('timer-running');
      player.hand.splice(i, 1);
      const phrase = toPhrase(card);
      player.smuggled.push(phrase);
      events.push({ type: 'smuggled', playerId: player.id, phrase });
      checkWin(game, player.id, events);
      return done();
    }

    case 'caught': {
      const i = findCard(action.cardId);
      if (i < 0) return fail('no-such-card');
      if (accusedNow) return fail('accusation-pending');
      if (action.catcherId === player.id) return fail('self-accuse');
      const catcher = action.catcherId ? game.players[action.catcherId] : undefined;
      if (action.catcherId && !catcher) return fail('no-such-player');
      const phrase = seize(game, player, i);
      if (catcher) catcher.swapCredits += 1;
      events.push({ type: 'seized', playerId: player.id, catcherId: catcher?.id ?? null, phrase });
      checkWin(game, player.id, events);
      return done();
    }

    case 'grantSwap': {
      if (!canCall(player)) return fail('no-badges');
      player.swapCredits += 1;
      return done();
    }

    case 'swap': {
      if (player.swapCredits <= 0) return fail('no-swap');
      if (action.cardId === null) {
        player.swapCredits -= 1;
        return done();
      }
      const i = findCard(action.cardId);
      if (i < 0) return fail('no-such-card');
      if (isDeclared(player.hand[i])) return fail('card-in-play');
      const replacement = draw(game);
      if (!replacement) return fail('pile-empty');
      player.hand.splice(i, 1, replacement);
      player.swapCredits -= 1;
      events.push({ type: 'swapped', playerId: player.id });
      return done();
    }

    case 'wrongCall': {
      if (!canCall(player)) return fail('no-badges');
      penalise(game, player);
      events.push({ type: 'wrongCall', playerId: player.id, accusedId: null, badgesLeft: player.badges });
      return done();
    }

    case 'accuse': {
      if (game.accusation) return fail('accusation-pending');
      if (action.accusedId === player.id) return fail('self-accuse');
      if (!game.players[action.accusedId]) return fail('no-such-player');
      if (!canCall(player)) return fail('no-badges');
      game.accusation = { callerId: player.id, accusedId: action.accusedId, at: action.now };
      events.push({ type: 'accused', playerId: player.id, accusedId: action.accusedId });
      return done();
    }

    case 'resolve': {
      const accusation = game.accusation;
      if (!accusation) return fail('no-accusation');
      if (accusation.accusedId !== player.id) return fail('not-accused');
      const caller = game.players[accusation.callerId];

      if (action.cardId !== null) {
        const i = findCard(action.cardId);
        if (i < 0) return fail('no-such-card');
        const card = player.hand[i];
        if (!isDeclared(card)) return fail('not-declared');
        // The call only counts if it landed inside the 30 seconds.
        if (!isLive(card, accusation.at)) return fail('timer-expired');
        const phrase = seize(game, player, i);
        if (caller) caller.swapCredits += 1;
        events.push({ type: 'seized', playerId: player.id, catcherId: caller?.id ?? null, phrase });
      } else if (caller) {
        penalise(game, caller);
        events.push({ type: 'wrongCall', playerId: caller.id, accusedId: player.id, badgesLeft: caller.badges });
      }

      resumeTimers(game, accusation, action.now);
      game.accusation = null;
      checkWin(game, player.id, events);
      return done();
    }
  }
}

/**
 * Clocks stop for the accused while a call is being argued over. When it is
 * settled, cards that were still counting get the paused time back.
 */
function resumeTimers(game: Game, accusation: Accusation, now: number): void {
  const accused = game.players[accusation.accusedId];
  if (!accused) return;
  const paused = Math.max(0, now - accusation.at);
  for (const card of accused.hand) {
    if (isLive(card, accusation.at)) card.saidAt = card.saidAt! + paused;
  }
}

/**
 * The "now" a player's countdowns should be drawn against: frozen at the moment
 * of the call while they are the accused.
 */
export function clockFor(game: Pick<Game, 'accusation'>, playerId: string, now: number): number {
  const a = game.accusation;
  return a && a.accusedId === playerId ? Math.min(now, a.at) : now;
}
