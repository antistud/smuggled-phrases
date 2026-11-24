import core from '../packs/core.json';
import travel from '../packs/travel.json';

export type PackRating = 'family' | 'adult';

/**
 * A phrase pack. To add one: drop a JSON file with this shape into src/packs/
 * and register it in PACKS below. Custom packs can be passed to buildDeck()
 * directly without being registered.
 */
export interface Pack {
  id: string;
  name: string;
  description: string;
  rating: PackRating;
  version: number;
  phrases: string[];
}

export interface Phrase {
  /** Stable within a pack version: "<packId>:<index>". */
  id: string;
  text: string;
}

export const PACKS: Pack[] = [core as Pack, travel as Pack];
export const DEFAULT_PACK_IDS = ['core'];

export function getPack(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/** Drops unknown ids, de-duplicates and sorts so every device agrees on order. */
export function normalizePackIds(ids: readonly string[], packs: readonly Pack[] = PACKS): string[] {
  const known = new Set(packs.map((p) => p.id));
  const out = [...new Set(ids.filter((id) => known.has(id)))].sort();
  return out.length ? out : DEFAULT_PACK_IDS.slice();
}

/** Flattens the chosen packs into one ordered, de-duplicated list of phrases. */
export function buildDeck(packIds: readonly string[], packs: readonly Pack[] = PACKS): Phrase[] {
  const seen = new Set<string>();
  const deck: Phrase[] = [];
  for (const id of normalizePackIds(packIds, packs)) {
    const pack = packs.find((p) => p.id === id)!;
    pack.phrases.forEach((text, i) => {
      const key = text.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      deck.push({ id: `${pack.id}:${i}`, text: text.trim() });
    });
  }
  return deck;
}

/** Identifies the exact deck contents, so a changed pack never reuses an old shuffle. */
export function deckSignature(packIds: readonly string[], packs: readonly Pack[] = PACKS): string {
  return normalizePackIds(packIds, packs)
    .map((id) => `${id}@${packs.find((p) => p.id === id)!.version}`)
    .join('+');
}
