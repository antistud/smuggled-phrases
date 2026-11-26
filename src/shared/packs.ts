import core from '../packs/core.json';
import travel from '../packs/travel.json';
import thanksgiving from '../packs/thanksgiving.json';
import christmas from '../packs/christmas.json';
import newyear from '../packs/newyear.json';
import readers from '../packs/readers.json';
import mafia from '../packs/mafia.json';
import sports from '../packs/sports.json';
import impossible from '../packs/impossible.json';
import comedy from '../packs/comedy.json';

export type PackRating = 'family' | 'adult';

/** How hard a phrase is to slip into conversation. */
export type Tier = 'easy' | 'medium' | 'hard';
export const TIERS: readonly Tier[] = ['easy', 'medium', 'hard'];
export const HEAT: Record<Tier, 1 | 2 | 3> = { easy: 1, medium: 2, hard: 3 };

/**
 * A phrase pack. To add one: drop a JSON file with this shape into src/packs/
 * and register it in PACKS below. Every phrase lives in a difficulty tier so a
 * game's spiciness can decide the mix. Custom packs can be passed to
 * buildDeck() directly without being registered.
 */
export interface Pack {
  id: string;
  name: string;
  /** An emoji shown on the pack's card in the picker. */
  icon?: string;
  description: string;
  rating: PackRating;
  version: number;
  phrases: Record<Tier, string[]>;
}

export interface Phrase {
  /** Stable within a pack version: "<packId>:<tier initial><index>". */
  id: string;
  text: string;
  /** 1 easy, 2 medium, 3 hard. */
  heat: 1 | 2 | 3;
}

/** A deck split by difficulty, ready to be mixed to a spiciness level. */
export type TieredDeck = Record<Tier, Phrase[]>;

export const PACKS: Pack[] = [core, travel, thanksgiving, christmas, newyear, readers, mafia, sports, impossible, comedy] as Pack[];
export const DEFAULT_PACK_IDS = ['core'];

export function getPack(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

export function packSize(pack: Pack): number {
  return TIERS.reduce((n, tier) => n + (pack.phrases[tier]?.length ?? 0), 0);
}

/** Drops unknown ids, de-duplicates and sorts so every device agrees on order. */
export function normalizePackIds(ids: readonly string[], packs: readonly Pack[] = PACKS): string[] {
  const known = new Set(packs.map((p) => p.id));
  const out = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => known.has(id)))].sort();
  return out.length ? out : DEFAULT_PACK_IDS.slice();
}

/** Flattens the chosen packs into one ordered, de-duplicated list per tier. */
export function buildDeck(packIds: readonly string[], packs: readonly Pack[] = PACKS): TieredDeck {
  const seen = new Set<string>();
  const deck: TieredDeck = { easy: [], medium: [], hard: [] };
  for (const id of normalizePackIds(packIds, packs)) {
    const pack = packs.find((p) => p.id === id)!;
    for (const tier of TIERS) {
      (pack.phrases[tier] ?? []).forEach((text, i) => {
        const key = text.trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        deck[tier].push({ id: `${pack.id}:${tier[0]}${i}`, text: text.trim(), heat: HEAT[tier] });
      });
    }
  }
  return deck;
}

export function deckSize(deck: TieredDeck): number {
  return TIERS.reduce((n, tier) => n + deck[tier].length, 0);
}

/** Identifies the exact deck contents, so a changed pack never reuses an old shuffle. */
export function deckSignature(packIds: readonly string[], packs: readonly Pack[] = PACKS): string {
  return normalizePackIds(packIds, packs)
    .map((id) => `${id}@${packs.find((p) => p.id === id)!.version}`)
    .join('+');
}
