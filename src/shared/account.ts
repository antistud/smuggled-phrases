/**
 * Accounts: email sign-in by magic link (or the 6-digit code in the same
 * email) and the lifetime record kept for each player.
 *
 * Pure state transitions only. The Durable Object in worker/ does the hashing,
 * storage and email; nothing secret is ever stored in the clear here: tokens,
 * codes and sessions are kept as hashes.
 */
import { cleanName } from './names';

export const LOGIN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const MIN_SEND_GAP_MS = 45 * 1000;
export const MAX_SENDS_PER_HOUR = 6;
export const MAX_SESSIONS = 10;
/** Largest change a single client-reported batch may make to any counter. */
export const MAX_REPORTED_DELTA = 500;

export const STAT_KEYS = ['smuggled', 'seized', 'busts', 'wrongCalls', 'getaways', 'games'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
/** smuggled: phrases cleared. seized: phrases lost. busts: catches made. getaways: wins. */
export type Stats = Record<StatKey, number>;
export type StatDelta = Partial<Stats>;

export interface PendingLogin {
  tokenHash: string;
  codeHash: string;
  expires: number;
  attempts: number;
}

export interface Account {
  email: string;
  name: string;
  createdAt: number;
  /** Set the first time a login is completed. */
  verifiedAt: number | null;
  stats: Stats;
  pending: PendingLogin | null;
  /** sessionHash -> expiry. */
  sessions: Record<string, number>;
  /** Times a login email was sent, for rate limiting. */
  sends: number[];
  /** Recent client batch ids, so a retried report is not counted twice. */
  batches: string[];
}

export interface PublicAccount {
  email: string;
  name: string;
  stats: Stats;
}

export type AccountError = 'bad-email' | 'too-soon' | 'too-many' | 'no-login' | 'expired' | 'wrong-code' | 'locked' | 'not-signed-in';

export function emptyStats(): Stats {
  return { smuggled: 0, seized: 0, busts: 0, wrongCalls: 0, getaways: 0, games: 0 };
}

export function addStats(stats: Stats, delta: StatDelta, cap = Number.POSITIVE_INFINITY): Stats {
  const out = { ...emptyStats(), ...stats };
  for (const key of STAT_KEYS) {
    const n = Math.floor(Number(delta?.[key]));
    if (Number.isFinite(n) && n > 0) out[key] += Math.min(n, cap);
  }
  return out;
}

export function normalizeEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function newAccount(email: string, now: number): Account {
  return { email, name: '', createdAt: now, verifiedAt: null, stats: emptyStats(), pending: null, sessions: {}, sends: [], batches: [] };
}

export function publicAccount(account: Account): PublicAccount {
  return { email: account.email, name: account.name, stats: { ...emptyStats(), ...account.stats } };
}

type Step = { ok: true; account: Account } | { ok: false; error: AccountError; account: Account };

/** Records a new login attempt, replacing any earlier one. Rate limited per address. */
export function startLogin(account: Account, hashes: { tokenHash: string; codeHash: string }, now: number): Step {
  const sends = account.sends.filter((t) => now - t < 60 * 60 * 1000);
  if (sends.length && now - sends[sends.length - 1] < MIN_SEND_GAP_MS) return { ok: false, error: 'too-soon', account };
  if (sends.length >= MAX_SENDS_PER_HOUR) return { ok: false, error: 'too-many', account };
  return {
    ok: true,
    account: { ...account, sends: [...sends, now], pending: { ...hashes, expires: now + LOGIN_TTL_MS, attempts: 0 } },
  };
}

/**
 * Completes a login with either the link token or the typed code. The pending
 * login is single use; wrong codes are counted and lock it after a few tries.
 */
export function finishLogin(
  account: Account,
  proof: { tokenHash?: string; codeHash?: string },
  sessionHash: string,
  now: number,
): Step {
  const pending = account.pending;
  if (!pending) return { ok: false, error: 'no-login', account };
  if (now > pending.expires) return { ok: false, error: 'expired', account: { ...account, pending: null } };
  if (pending.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: 'locked', account };
  const matches = (proof.tokenHash && proof.tokenHash === pending.tokenHash) || (proof.codeHash && proof.codeHash === pending.codeHash);
  if (!matches) {
    return { ok: false, error: 'wrong-code', account: { ...account, pending: { ...pending, attempts: pending.attempts + 1 } } };
  }
  // Keep the newest sessions; drop expired ones.
  const live = Object.entries(account.sessions)
    .filter(([, expires]) => expires > now)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SESSIONS - 1);
  return {
    ok: true,
    account: {
      ...account,
      pending: null,
      verifiedAt: account.verifiedAt ?? now,
      sessions: { ...Object.fromEntries(live), [sessionHash]: now + SESSION_TTL_MS },
    },
  };
}

export function hasSession(account: Account | null, sessionHash: string, now: number): boolean {
  return !!account && (account.sessions[sessionHash] ?? 0) > now;
}

export function endSession(account: Account, sessionHash: string): Account {
  const sessions = { ...account.sessions };
  delete sessions[sessionHash];
  return { ...account, sessions };
}

export function rename(account: Account, name: string): Account {
  return { ...account, name: cleanName(name) };
}

/**
 * Adds to the record. `batchId` makes a client report idempotent, and `cap`
 * bounds what a client can claim in one go; the server's own awards pass neither.
 */
export function recordStats(account: Account, delta: StatDelta, batchId?: string, cap?: number): Account {
  if (batchId && account.batches.includes(batchId)) return account;
  return {
    ...account,
    stats: addStats(account.stats, delta, cap),
    batches: batchId ? [...account.batches, batchId].slice(-40) : account.batches,
  };
}
