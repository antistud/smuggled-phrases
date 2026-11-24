import { describe, expect, it } from 'vitest';
import {
  createOfflineGame,
  manifestNumber,
  MAX_OFFLINE_PLAYERS,
  OFFLINE_PLAYER_ID,
  shuffledDeck,
  stripeFor,
} from '../src/shared/deal';
import { buildDeck, normalizePackIds, PACKS, type Pack } from '../src/shared/packs';
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

  it('gives the same deck for the same code on every phone', () => {
    expect(shuffledDeck('WXYZ', packs)).toEqual(shuffledDeck('wxyz', packs));
    expect(shuffledDeck('WXYZ', packs).map((p) => p.id)).not.toEqual(shuffledDeck('WXYA', packs).map((p) => p.id));
    expect(shuffledDeck('WXYZ', ['core', 'travel'])).toEqual(shuffledDeck('WXYZ', ['travel', 'core', 'nope']));
  });

  it('stripes are disjoint and together cover the whole deck', () => {
    const deck = shuffledDeck('GOAT', ['core', 'travel']);
    const stripes = Array.from({ length: MAX_OFFLINE_PLAYERS }, (_, i) => stripeFor(deck, i + 1));
    const all = stripes.flat().map((p) => p.id);
    expect(all).toHaveLength(deck.length);
    expect(new Set(all).size).toBe(deck.length);
    for (const s of stripes) expect(s.length).toBeGreaterThanOrEqual(Math.floor(deck.length / MAX_OFFLINE_PLAYERS));
    expect(() => stripeFor(deck, 0)).toThrow(RangeError);
    expect(() => stripeFor(deck, MAX_OFFLINE_PLAYERS + 1)).toThrow(RangeError);
  });

  it('no two players ever hold the same phrase, even after every possible draw', () => {
    for (const code of ['AAAA', 'QRST', 'ZZZZ']) {
      const seen = new Map<string, number>();
      for (let n = 1; n <= MAX_OFFLINE_PLAYERS; n++) {
        let g: Game = createOfflineGame(code, packs, n);
        expect(g.players[OFFLINE_PLAYER_ID].hand).toHaveLength(HAND_SIZE);
        const mine = [...g.players[OFFLINE_PLAYER_ID].hand.map((c) => c.id)];
        // Drain the stripe through replacement draws: get caught over and over.
        while (g.pile.length > 0) {
          const id = g.players[OFFLINE_PLAYER_ID].hand[0].id;
          let r = applyAction(g, { type: 'declare', playerId: OFFLINE_PLAYER_ID, cardId: id, now: 1 });
          if (!r.ok) throw new Error(r.error);
          r = applyAction(r.game, { type: 'caught', playerId: OFFLINE_PLAYER_ID, cardId: id });
          if (!r.ok) throw new Error(r.error);
          g = r.game;
          mine.push(g.players[OFFLINE_PLAYER_ID].hand[0].id);
        }
        for (const id of mine) {
          expect(seen.has(id), `${id} dealt to players ${seen.get(id)} and ${n}`).toBe(false);
          seen.set(id, n);
        }
      }
    }
  });

  it('every player has plenty of replacement draws', () => {
    const g = createOfflineGame('DUCK', packs, MAX_OFFLINE_PLAYERS);
    expect(g.pile.length).toBeGreaterThanOrEqual(20);
  });

  it('a reload re-deals the identical hand', () => {
    expect(createOfflineGame('LAMA', packs, 4)).toEqual(createOfflineGame('LAMA', packs, 4));
    expect(createOfflineGame('LAMA', packs, 4).players.me.hand).not.toEqual(createOfflineGame('LAMA', packs, 5).players.me.hand);
  });

  it('manifest number matches only for the same code and packs', () => {
    expect(manifestNumber('LAMA', ['core'])).toMatch(/^\d{3}$/);
    expect(manifestNumber('LAMA', ['travel', 'core'])).toBe(manifestNumber('lama', ['core', 'travel']));
  });
});

describe('phrase packs', () => {
  it('ships at least 300 unique family-friendly phrases in the core pack', () => {
    const core = PACKS.find((p) => p.id === 'core')!;
    expect(core.rating).toBe('family');
    expect(core.phrases.length).toBeGreaterThanOrEqual(300);
    expect(buildDeck(['core'])).toHaveLength(core.phrases.length);
  });

  it('has no duplicates across packs and no blank or oversized phrases', () => {
    const all = PACKS.flatMap((p) => p.phrases);
    expect(new Set(all.map((t) => t.trim().toLowerCase())).size).toBe(all.length);
    for (const text of all) {
      expect(text.trim()).toBe(text);
      expect(text.length).toBeGreaterThan(3);
      expect(text.length).toBeLessThanOrEqual(80);
    }
  });

  it('mixes short noun phrases with full sentences', () => {
    const core = PACKS.find((p) => p.id === 'core')!.phrases;
    const sentences = core.filter((t) => /[.!?]$/.test(t)).length;
    expect(sentences).toBeGreaterThan(100);
    expect(core.length - sentences).toBeGreaterThan(100);
  });

  it('accepts extra packs without registering them', () => {
    const custom: Pack = { id: 'custom', name: 'Ours', description: '', rating: 'adult', version: 1, phrases: ['one thing', 'One Thing ', 'two things'] };
    const packs = [...PACKS, custom];
    expect(buildDeck(['custom'], packs).map((p) => p.id)).toEqual(['custom:0', 'custom:2']);
    expect(normalizePackIds(['custom'])).toEqual(['core']);
    expect(normalizePackIds(['custom', 'core', 'custom'], packs)).toEqual(['core', 'custom']);
  });
});
