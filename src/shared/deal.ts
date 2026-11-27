/**
 * The seeded offline deal.
 *
 * Every phone shuffles the same deck with a PRNG seeded from the game code,
 * one difficulty tier at a time, then takes only the cards at positions
 * belonging to its player number (number 1 gets 0, 10, 20…; number 2 gets
 * 1, 11, 21…). The stripes never overlap, so no two phones can hold the same
 * phrase and replacement draws can never collide, with no network at all.
 *
 * Each phone then weaves its own three tier stripes together at the game's
 * spiciness. Because the striping happens before the mixing, phones stay
 * collision-free even if someone picks the wrong spiciness.
 */
import { buildDeck, deckSignature, normalizePackIds, PACKS, TIERS, type Pack, type Phrase, type TieredDeck } from './packs';
import { hashString, mulberry32, shuffle } from './prng';
import { createGame, type Game } from './rules';
import { DEFAULT_SETTINGS, mixPile, normalizeSettings, type GameSettings } from './settings';

/** Number of stripes, i.e. the most players an offline game supports. */
export const MAX_OFFLINE_PLAYERS = 10;
export const OFFLINE_PLAYER_ID = 'me';

export function offlineSeed(code: string, packIds: readonly string[], packs: readonly Pack[] = PACKS): number {
  return hashString(`smuggled|${code.toUpperCase()}|${deckSignature(packIds, packs)}`);
}

/** The full deck, each tier shuffled the same way on every phone in this game. */
export function shuffledDeck(code: string, packIds: readonly string[], packs: readonly Pack[] = PACKS): TieredDeck {
  const deck = buildDeck(packIds, packs);
  const seed = offlineSeed(code, packIds, packs);
  const out = {} as TieredDeck;
  for (const tier of TIERS) out[tier] = shuffle(deck[tier], mulberry32(hashString(`${seed}|${tier}`)));
  return out;
}

/** One player's private slice of a shuffled list. playerNumber is 1-based. */
export function stripeFor<T>(list: readonly T[], playerNumber: number, stripes = MAX_OFFLINE_PLAYERS): T[] {
  if (!Number.isInteger(playerNumber) || playerNumber < 1 || playerNumber > stripes) {
    throw new RangeError(`player number must be 1-${stripes}`);
  }
  return list.filter((_, i) => i % stripes === playerNumber - 1);
}

/** This phone's whole private draw pile, mixed to the game's spiciness. */
export function offlinePile(
  code: string,
  packIds: readonly string[],
  playerNumber: number,
  spice: number = DEFAULT_SETTINGS.spice,
  packs: readonly Pack[] = PACKS,
): Phrase[] {
  const deck = shuffledDeck(code, packIds, packs);
  const mine = {} as TieredDeck;
  for (const tier of TIERS) mine[tier] = stripeFor(deck[tier], playerNumber);
  return mixPile(mine, spice, mulberry32(hashString(`mix|${code.toUpperCase()}|${playerNumber}`)));
}

/** A single-player game holding this phone's hand and its private draw pile. */
export function createOfflineGame(
  code: string,
  packIds: readonly string[],
  playerNumber: number,
  settings: Partial<GameSettings> = DEFAULT_SETTINGS,
  packs: readonly Pack[] = PACKS,
): Game {
  const { handSize, spice } = normalizeSettings(settings);
  return createGame([OFFLINE_PLAYER_ID], offlinePile(code, packIds, playerNumber, spice, packs), handSize);
}

/**
 * A short number every phone can compare out loud to confirm they entered the
 * same code and picked the same packs and settings.
 */
export function manifestNumber(
  code: string,
  packIds: readonly string[],
  settings: Partial<GameSettings> = DEFAULT_SETTINGS,
  packs: readonly Pack[] = PACKS,
): string {
  const { handSize, spice, calls } = normalizeSettings(settings);
  const key = `manifest|${code.toUpperCase()}|${deckSignature(normalizePackIds(packIds, packs), packs)}|${handSize}|${spice}${calls ? '' : '|quiet'}`;
  return String(hashString(key) % 1000).padStart(3, '0');
}
