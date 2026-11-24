/**
 * The seeded offline deal.
 *
 * Every phone shuffles the same deck with a PRNG seeded from the game code,
 * then takes only the cards at positions belonging to its player number
 * (number 1 gets 0, 10, 20…; number 2 gets 1, 11, 21…). The stripes never
 * overlap, so no two phones can hold the same phrase and replacement draws
 * can never collide, with no network at all.
 */
import { buildDeck, deckSignature, normalizePackIds, PACKS, type Pack, type Phrase } from './packs';
import { hashString, mulberry32, shuffle } from './prng';
import { createGame, type Game } from './rules';

/** Number of stripes, i.e. the most players an offline game supports. */
export const MAX_OFFLINE_PLAYERS = 10;
export const OFFLINE_PLAYER_ID = 'me';

export function offlineSeed(code: string, packIds: readonly string[], packs: readonly Pack[] = PACKS): number {
  return hashString(`smuggled|${code.toUpperCase()}|${deckSignature(packIds, packs)}`);
}

/** The full shuffled deck every phone in this offline game agrees on. */
export function shuffledDeck(code: string, packIds: readonly string[], packs: readonly Pack[] = PACKS): Phrase[] {
  return shuffle(buildDeck(packIds, packs), mulberry32(offlineSeed(code, packIds, packs)));
}

/** One player's private slice of the shuffled deck. playerNumber is 1-based. */
export function stripeFor(deck: readonly Phrase[], playerNumber: number, stripes = MAX_OFFLINE_PLAYERS): Phrase[] {
  if (!Number.isInteger(playerNumber) || playerNumber < 1 || playerNumber > stripes) {
    throw new RangeError(`player number must be 1-${stripes}`);
  }
  return deck.filter((_, i) => i % stripes === playerNumber - 1);
}

/** A single-player game holding this phone's hand and its private draw pile. */
export function createOfflineGame(
  code: string,
  packIds: readonly string[],
  playerNumber: number,
  packs: readonly Pack[] = PACKS,
): Game {
  const stripe = stripeFor(shuffledDeck(code, packIds, packs), playerNumber);
  return createGame([OFFLINE_PLAYER_ID], stripe);
}

/**
 * A short number every phone can compare out loud to confirm they entered the
 * same code and picked the same packs.
 */
export function manifestNumber(code: string, packIds: readonly string[], packs: readonly Pack[] = PACKS): string {
  const n = hashString(`manifest|${code.toUpperCase()}|${deckSignature(normalizePackIds(packIds, packs), packs)}`) % 1000;
  return String(n).padStart(3, '0');
}
