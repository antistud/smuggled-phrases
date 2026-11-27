import { describe, expect, it } from 'vitest';
import {
  createOfflineGame,
  manifestNumber,
  MAX_OFFLINE_PLAYERS,
  OFFLINE_PLAYER_ID,
  offlinePile,
  shuffledDeck,
  stripeFor,
} from '../src/shared/deal';
import { buildDeck, deckSize, normalizePackIds, PACKS, TIERS, type Pack, type Phrase, type TieredDeck } from '../src/shared/packs';
import { DEFAULT_SETTINGS, MAX_HAND_SIZE, MIN_HAND_SIZE, mixPile, normalizeSettings, SPICE_LEVELS } from '../src/shared/settings';
import { hashString, mulberry32, normalizeCode, randomCode, shuffle } from '../src/shared/prng';
import { applyAction, HAND_SIZE, type Game } from '../src/shared/rules';

describe('prng', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const seqA = Array.from({ length: 5 }, a), seqB = Array.from({ length: 5 }, b), seqC = Array.from({ length: 5 }, c);
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('produces known values, so every platform shuffles identically', () => {
    expect(hashString('smuggled')).toBe(hashString('smuggled'));
    expect(hashString('ABCD')).not.toBe(hashString('ABCE'));
    const r = mulberry32(123456789);
    expect([r(), r(), r()].map((n) => Math.floor(n * 1e6))).toMatchInlineSnapshot(`
      [
        257790,
        970772,
        785328,
      ]
    `);
  });

  it('shuffle keeps every item exactly once and does not mutate', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const out = shuffle(items, mulberry32(7));
    expect(items[0]).toBe(0);
    expect(out).not.toEqual(items);
    expect([...out].sort((x, y) => x - y)).toEqual(items);
  });

  it('makes and normalises 4-letter codes', () => {
    const code = randomCode(mulberry32(1));
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    expect(normalizeCode(' ab-cd ')).toBe('ABCD');
    expect(normalizeCode('abc')).toBe('');
    expect(normalizeCode('ab0i')).toBe('ABQJ');
  });
});

describe('seeded offline deal', () => {
  const packs = ['core'];
  const ids = (deck: TieredDeck) => TIERS.flatMap((t) => deck[t].map((p) => p.id));

  it('gives the same deck for the same code on every phone', () => {
    expect(shuffledDeck('WXYZ', packs)).toEqual(shuffledDeck('wxyz', packs));
    expect(ids(shuffledDeck('WXYZ', packs))).not.toEqual(ids(shuffledDeck('WXYA', packs)));
    expect(shuffledDeck('WXYZ', ['core', 'travel'])).toEqual(shuffledDeck('WXYZ', ['travel', 'core', 'nope']));
  });

  it('stripes are disjoint and together cover the whole deck', () => {
    const deck = shuffledDeck('GOAT', ['core', 'travel']);
    const all = TIERS.flatMap((t) => deck[t]);
    const stripes = Array.from({ length: MAX_OFFLINE_PLAYERS }, (_, i) => stripeFor(all, i + 1));
    const flat = stripes.flat().map((p) => p.id);
    expect(flat).toHaveLength(all.length);
    expect(new Set(flat).size).toBe(all.length);
    expect(() => stripeFor(all, 0)).toThrow(RangeError);
    expect(() => stripeFor(all, MAX_OFFLINE_PLAYERS + 1)).toThrow(RangeError);
  });

  it('no two players ever hold the same phrase, whatever spiciness each phone picked', () => {
    for (const code of ['AAAA', 'QRST', 'ZZZZ']) {
      const seen = new Map<string, number>();
      for (let n = 1; n <= MAX_OFFLINE_PLAYERS; n++) {
        // Deliberately mismatched settings: collisions must still be impossible.
        const pile = offlinePile(code, packs, n, (n % 5) + 1);
        expect(new Set(pile.map((p) => p.id)).size).toBe(pile.length);
        for (const p of pile) {
          expect(seen.has(p.id), `${p.id} dealt to players ${seen.get(p.id)} and ${n}`).toBe(false);
          seen.set(p.id, n);
        }
      }
      expect(seen.size).toBe(deckSize(buildDeck(packs)));
    }
  });

  it('replacement draws come from the same private pile', () => {
    let g: Game = createOfflineGame('DUCK', packs, 3, { handSize: 5, spice: 3, catchphrase: true });
    const pile = offlinePile('DUCK', packs, 3, 3).map((p) => p.id);
    expect(g.players[OFFLINE_PLAYER_ID].hand.map((c) => c.id)).toEqual(pile.slice(0, HAND_SIZE));
    const id = g.players[OFFLINE_PLAYER_ID].hand[0].id;
    let r = applyAction(g, { type: 'declare', playerId: OFFLINE_PLAYER_ID, cardId: id, now: 1 });
    if (!r.ok) throw new Error(r.error);
    r = applyAction(r.game, { type: 'caught', playerId: OFFLINE_PLAYER_ID, cardId: id });
    if (!r.ok) throw new Error(r.error);
    g = r.game;
    // The catchphrase was lifted out of the pile after the hand was dealt.
    const catchphrase = g.players[OFFLINE_PLAYER_ID].catchphrase!;
    expect(catchphrase.heat).toBe(1);
    expect(pile.slice(HAND_SIZE)).toContain(catchphrase.id);
    expect(g.players[OFFLINE_PLAYER_ID].hand[0].id).toBe(pile.slice(HAND_SIZE).filter((p) => p !== catchphrase.id)[0]);
  });

  it('honours hand size and gives every player plenty of replacement draws', () => {
    for (let n = 1; n <= MAX_OFFLINE_PLAYERS; n++) {
      const g = createOfflineGame('DUCK', packs, n, { handSize: 8, spice: 5 });
      expect(g.players[OFFLINE_PLAYER_ID].hand).toHaveLength(8);
      expect(g.pile.length).toBeGreaterThanOrEqual(80);
    }
  });

  it('a reload re-deals the identical hand', () => {
    expect(createOfflineGame('LAMA', packs, 4)).toEqual(createOfflineGame('LAMA', packs, 4));
    expect(createOfflineGame('LAMA', packs, 4).players.me.hand).not.toEqual(createOfflineGame('LAMA', packs, 5).players.me.hand);
  });

  it('manifest number matches only for the same code, packs and settings', () => {
    expect(manifestNumber('LAMA', ['core'])).toMatch(/^\d{3}$/);
    expect(manifestNumber('LAMA', ['travel', 'core'])).toBe(manifestNumber('lama', ['core', 'travel']));
    const variants = new Set([1, 2, 3, 4, 5].flatMap((spice) => [3, 5, 8].map((handSize) => manifestNumber('LAMA', ['core'], { handSize, spice }))));
    expect(variants.size).toBeGreaterThan(10);
  });
});

describe('spiciness mix', () => {
  const deck = buildDeck(['core', 'travel']);
  const share = (pile: Phrase[], heat: number) => (100 * pile.filter((p) => p.heat === heat).length) / pile.length;

  it('every level is a mix that adds up to 100% with no empty tier', () => {
    expect(SPICE_LEVELS.map((s) => s.level)).toEqual([1, 2, 3, 4, 5]);
    for (const s of SPICE_LEVELS) {
      expect(s.mix.easy + s.mix.medium + s.mix.hard).toBe(100);
      expect(Math.min(s.mix.easy, s.mix.medium, s.mix.hard)).toBeGreaterThan(0);
    }
    for (let i = 1; i < SPICE_LEVELS.length; i++) {
      expect(SPICE_LEVELS[i].mix.hard).toBeGreaterThan(SPICE_LEVELS[i - 1].mix.hard);
      expect(SPICE_LEVELS[i].mix.easy).toBeLessThan(SPICE_LEVELS[i - 1].mix.easy);
    }
  });

  it('the first 100 draws match the level percentages closely', () => {
    for (const s of SPICE_LEVELS) {
      const pile = mixPile(deck, s.level, mulberry32(s.level)).slice(0, 100);
      expect(Math.abs(share(pile, 1) - s.mix.easy)).toBeLessThanOrEqual(2);
      expect(Math.abs(share(pile, 2) - s.mix.medium)).toBeLessThanOrEqual(2);
      expect(Math.abs(share(pile, 3) - s.mix.hard)).toBeLessThanOrEqual(2);
    }
  });

  it('every dealt hand is a blend, never a single difficulty', () => {
    for (const s of SPICE_LEVELS) {
      for (let seed = 0; seed < 20; seed++) {
        const pile = mixPile(deck, s.level, mulberry32(seed));
        for (const handSize of [3, 5, 8]) {
          for (let start = 0; start + handSize <= 96; start += handSize) {
            const heats = new Set(pile.slice(start, start + handSize).map((p) => p.heat));
            expect(heats.size, `spice ${s.level}, hand of ${handSize} at ${start}`).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
  });

  it('uses every phrase exactly once and keeps going when a tier runs out', () => {
    const pile = mixPile(deck, 5, mulberry32(1));
    expect(pile).toHaveLength(deckSize(deck));
    expect(new Set(pile.map((p) => p.id)).size).toBe(pile.length);
    const tiny = { easy: deck.easy.slice(0, 2), medium: deck.medium.slice(0, 30), hard: deck.hard.slice(0, 1) };
    expect(mixPile(tiny, 3, mulberry32(1))).toHaveLength(33);
  });

  it('normalises settings from anywhere', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ handSize: 2.6, spice: 9 })).toEqual({ handSize: MIN_HAND_SIZE, spice: 5, catchphrase: false });
    expect(normalizeSettings({ catchphrase: true }).catchphrase).toBe(true);
    expect(normalizeSettings({ catchphrase: 'yes' as unknown as boolean }).catchphrase).toBe(false);
    expect(manifestNumber('LAMA', ['core'], { catchphrase: false })).not.toBe(manifestNumber('LAMA', ['core'], { catchphrase: true }));
    expect(normalizeSettings({ handSize: Number.NaN, spice: 'hot' as unknown as number })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ handSize: 50 }).handSize).toBe(MAX_HAND_SIZE);
  });
});

describe('phrase packs', () => {
  const all = PACKS.flatMap((p) => TIERS.flatMap((t) => p.phrases[t]));

  it('ships over 1000 unique family-friendly phrases', () => {
    expect(all.length).toBeGreaterThan(1000);
    expect(new Set(all.map((t) => t.trim().toLowerCase())).size).toBe(all.length);
    expect(PACKS.every((p) => p.rating === 'family')).toBe(true);
    expect(deckSize(buildDeck(PACKS.map((p) => p.id)))).toBe(all.length);
  });

  it('gives every pack an icon, a unique id and phrases at every difficulty', () => {
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
    for (const pack of PACKS) {
      expect(pack.icon, pack.id).toBeTruthy();
      expect(pack.name.length, pack.id).toBeGreaterThan(0);
      for (const tier of TIERS) expect(pack.phrases[tier].length, `${pack.id} ${tier}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('has a deep bench at every difficulty in the core pack', () => {
    const core = PACKS.find((p) => p.id === 'core')!;
    for (const tier of TIERS) expect(core.phrases[tier].length, tier).toBeGreaterThanOrEqual(250);
    const deck = buildDeck(['core']);
    expect(deck.easy.every((p) => p.heat === 1)).toBe(true);
    expect(deck.hard.every((p) => p.heat === 3)).toBe(true);
  });

  it('gets harder as it goes: hard phrases are much longer than easy ones', () => {
    const core = PACKS.find((p) => p.id === 'core')!;
    const avg = (list: string[]) => list.reduce((n, t) => n + t.length, 0) / list.length;
    expect(avg(core.phrases.easy)).toBeLessThan(avg(core.phrases.medium));
    expect(avg(core.phrases.medium)).toBeLessThan(avg(core.phrases.hard));
    expect(core.phrases.hard.filter((t) => /[.!?]$/.test(t)).length).toBe(core.phrases.hard.length);
  });

  it('has no blank, untrimmed or oversized phrases', () => {
    for (const text of all) {
      expect(text.trim()).toBe(text);
      expect(text.length).toBeGreaterThan(3);
      expect(text.length).toBeLessThanOrEqual(80);
    }
  });

  it('accepts extra packs without registering them', () => {
    const custom: Pack = { id: 'custom', name: 'Ours', description: '', rating: 'adult', version: 1, phrases: { easy: ['one thing', 'One Thing '], medium: ['two things'], hard: [] } };
    const packs = [...PACKS, custom];
    expect(TIERS.flatMap((t) => buildDeck(['custom'], packs)[t].map((p) => p.id))).toEqual(['custom:e0', 'custom:m0']);
    expect(normalizePackIds(['custom'])).toEqual(['core']);
    expect(normalizePackIds(['custom', 'core', 'custom'], packs)).toEqual(['core', 'custom']);
  });
});
