/**
 * Per-game options: how many phrases each player starts with, and how spicy
 * the deal is. Spiciness never picks a single difficulty: every level is a mix
 * of easy, medium and hard phrases, and the level only moves the percentages.
 */
import { HEAT, TIERS, type Phrase, type Tier, type TieredDeck } from './packs';

export interface GameSettings {
  /** Phrases each player starts with. */
  handSize: number;
  /** 1 (mild) to 5 (inferno). */
  spice: number;
  /**
   * An optional add-on, off unless the host turns it on.
   * Whether every player also gets a catchphrase: one easy phrase that never
   * leaves, can be said over and over, and counts each time it gets through.
   */
  catchphrase: boolean;
}

export const MIN_HAND_SIZE = 3;
export const MAX_HAND_SIZE = 8;
export const DEFAULT_SETTINGS: GameSettings = { handSize: 5, spice: 2, catchphrase: false };

export interface SpiceLevel {
  level: number;
  name: string;
  blurb: string;
  /** Percent of the deal from each tier. Always sums to 100, never has a zero. */
  mix: Record<Tier, number>;
}

export const SPICE_LEVELS: readonly SpiceLevel[] = [
  { level: 1, name: 'Mild', blurb: 'Mostly easy slips. Good for a first run.', mix: { easy: 65, medium: 25, hard: 10 } },
  { level: 2, name: 'Medium', blurb: 'A fair mix with the odd stinker.', mix: { easy: 50, medium: 35, hard: 15 } },
  { level: 3, name: 'Hot', blurb: 'Even split. Somebody is getting caught.', mix: { easy: 30, medium: 40, hard: 30 } },
  { level: 4, name: 'Extra hot', blurb: 'Half the crate is hard to say with a straight face.', mix: { easy: 15, medium: 35, hard: 50 } },
  { level: 5, name: 'Inferno', blurb: 'Mostly long, absurd sentences. Good luck.', mix: { easy: 10, medium: 25, hard: 65 } },
];

export function spiceLevel(spice: number): SpiceLevel {
  return SPICE_LEVELS.find((s) => s.level === spice) ?? SPICE_LEVELS[DEFAULT_SETTINGS.spice - 1];
}

/** Clamps anything (including garbage from the network) into valid settings. */
export function normalizeSettings(raw: Partial<GameSettings> | null | undefined): GameSettings {
  const int = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    handSize: int(raw?.handSize, DEFAULT_SETTINGS.handSize, MIN_HAND_SIZE, MAX_HAND_SIZE),
    spice: int(raw?.spice, DEFAULT_SETTINGS.spice, 1, SPICE_LEVELS.length),
    catchphrase: typeof raw?.catchphrase === 'boolean' ? raw.catchphrase : DEFAULT_SETTINGS.catchphrase,
  };
}

/**
 * Weaves the three tiers into one draw pile at the spiciness mix.
 *
 * Uses smooth weighted round-robin, so the ratio holds in every stretch of the
 * pile and not just on average: any hand dealt from consecutive cards gets the
 * intended blend, and so do the replacement draws that follow. `rand` only
 * sets the starting phase so games do not all open with the same tier order.
 * No tier ever appears three times in a row while another is available, so
 * even a three-card hand is a mix. When a tier runs dry the pile continues
 * with what is left.
 */
export function mixPile(deck: TieredDeck, spice: number, rand: () => number): Phrase[] {
  const weights = spiceLevel(spice).mix;
  const next: Record<Tier, number> = { easy: 0, medium: 0, hard: 0 };
  const credit: Record<Tier, number> = { easy: rand() * weights.easy, medium: rand() * weights.medium, hard: rand() * weights.hard };
  const pile: Phrase[] = [];
  for (;;) {
    const open = TIERS.filter((tier) => next[tier] < deck[tier].length);
    if (open.length === 0) return pile;
    let total = 0;
    for (const tier of open) {
      credit[tier] += weights[tier];
      total += weights[tier];
    }
    // Skip a tier that would make three in a row, unless it is the only one left.
    const n = pile.length;
    const streak = n >= 2 && pile[n - 1].heat === pile[n - 2].heat ? pile[n - 1].heat : 0;
    const allowed = open.filter((tier) => HEAT[tier] !== streak);
    const pick = (allowed.length ? allowed : open).reduce((best, tier) => (credit[tier] > credit[best] ? tier : best));
    credit[pick] -= total;
    pile.push(deck[pick][next[pick]++]);
  }
}
