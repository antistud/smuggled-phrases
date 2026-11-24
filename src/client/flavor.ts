/** Jokes, aliases and ranks: everything that is flavour rather than rules. */
import { hashString } from '../shared/prng';
import { load, save } from './storage';

const FIRST = ['Sticky', 'Two-Sock', 'Quiet', 'Slippery', 'Lucky', 'Velvet', 'Crumbs', 'Whispering', 'Dusty', 'Lefty', 'Smooth', 'Wobbly', 'Midnight', 'Biscuit', 'Shifty', 'Soggy', 'Honest', 'Fancy'];
const LAST = ['Pete', 'Tina', 'Ferret', 'Mango', 'Llama', 'Doris', 'Pigeon', 'Marco', 'Noodle', 'Walrus', 'Gus', 'Pickle', 'Otter', 'Brenda', 'Goose', 'Kev', 'Turnip', 'Moth'];

export function randomAlias(): string {
  const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(FIRST)} ${pick(LAST)}`;
}

const NERVES = [
  'Act natural…',
  'Don’t look at the dog.',
  'Whistle casually.',
  'Nothing to see here.',
  'Eyes forward. Keep talking.',
  'Smile like you packed it yourself.',
  'Sweat quietly.',
  'You’ve got an honest face.',
  'Think boring thoughts.',
  'Just a normal sentence. Totally normal.',
];
const GLOATS = ['You slippery genius.', 'Clean as a whistle.', 'They never saw it coming.', 'Smooth. Criminally smooth.', 'Straight through the green lane.'];

/** A stable quip per card, so it does not flicker between renders. */
export const nervesFor = (cardId: string): string => NERVES[hashString(cardId) % NERVES.length];
export const gloatFor = (cardId: string): string => GLOATS[hashString(cardId) % GLOATS.length];

/** A little per-card mess: tilt and where the coffee ring landed. */
export function grimeFor(cardId: string): Record<string, string> {
  const h = hashString(cardId);
  return {
    '--tilt': `${(((h % 13) - 6) / 10).toFixed(1)}deg`,
    '--sx': `${10 + ((h >> 4) % 70)}%`,
    '--sy': `${20 + ((h >> 9) % 70)}%`,
  };
}

const RANKS: [number, string][] = [
  [0, 'Tourist'],
  [1, 'Pickpocket'],
  [3, 'Mule'],
  [8, 'Runner'],
  [15, 'Fixer'],
  [30, 'Fence'],
  [50, 'Kingpin'],
  [100, 'Legend of the Docks'],
];
export function rankFor(smuggled: number): string {
  let rank = RANKS[0][1];
  for (const [need, name] of RANKS) if (smuggled >= need) rank = name;
  return rank;
}

/** Lifetime record on this phone. */
export interface RapSheet {
  smuggled: number;
  seized: number;
  getaways: number;
}
export function rapSheet(): RapSheet {
  return { smuggled: 0, seized: 0, getaways: 0, ...(load<RapSheet>('rapsheet') ?? {}) };
}
export function addToRapSheet(delta: Partial<RapSheet>): void {
  const sheet = rapSheet();
  save('rapsheet', {
    smuggled: sheet.smuggled + (delta.smuggled ?? 0),
    seized: sheet.seized + (delta.seized ?? 0),
    getaways: sheet.getaways + (delta.getaways ?? 0),
  });
}

export const SAMPLE_PHRASES = ['emergency lasagna', 'the squirrel council', 'That’s exactly what the raccoons want.', 'a submarine full of bees', 'The moon owes me money.', 'tactical oven mitts'];
