import { describe, expect, it } from 'vitest';
import {
  addStats,
  emptyStats,
  endSession,
  finishLogin,
  hasSession,
  isValidEmail,
  LOGIN_TTL_MS,
  MAX_CODE_ATTEMPTS,
  MAX_REPORTED_DELTA,
  MAX_SENDS_PER_HOUR,
  MAX_SESSIONS,
  MIN_SEND_GAP_MS,
  newAccount,
  normalizeEmail,
  publicAccount,
  recordStats,
  rename,
  SESSION_TTL_MS,
  startLogin,
  type Account,
} from '../src/shared/account';

const T0 = 1_700_000_000_000;
const hashes = (n: number) => ({ tokenHash: `token-${n}`, codeHash: `code-${n}` });

function requested(now = T0, n = 1): Account {
  const step = startLogin(newAccount('ada@example.com', now), hashes(n), now);
  if (!step.ok) throw new Error(step.error);
  return step.account;
}
function signedIn(): Account {
  const step = finishLogin(requested(), { tokenHash: 'token-1' }, 'session-1', T0 + 1000);
  if (!step.ok) throw new Error(step.error);
  return step.account;
}

describe('email addresses', () => {
  it('normalises and validates', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(isValidEmail('ada@example.com')).toBe(true);
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'a da@example.com', `${'a'.repeat(250)}@x.io`]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});

describe('magic link sign-in', () => {
  it('signs in with the link token, once', () => {
    const account = requested();
    expect(account.pending).toMatchObject({ tokenHash: 'token-1', expires: T0 + LOGIN_TTL_MS, attempts: 0 });
    expect(account.verifiedAt).toBeNull();
    const step = finishLogin(account, { tokenHash: 'token-1' }, 'session-1', T0 + 5000);
    expect(step.ok).toBe(true);
    expect(step.account.pending).toBeNull();
    expect(step.account.verifiedAt).toBe(T0 + 5000);
    expect(hasSession(step.account, 'session-1', T0 + 6000)).toBe(true);
    // The same link cannot be used again.
    expect(finishLogin(step.account, { tokenHash: 'token-1' }, 'session-2', T0 + 7000)).toMatchObject({ ok: false, error: 'no-login' });
  });

  it('signs in with the typed code instead', () => {
    const step = finishLogin(requested(), { codeHash: 'code-1' }, 'session-1', T0 + 5000);
    expect(step.ok).toBe(true);
  });

  it('never matches an empty proof', () => {
    expect(finishLogin(requested(), {}, 's', T0).ok).toBe(false);
    expect(finishLogin(requested(), { tokenHash: '', codeHash: '' }, 's', T0).ok).toBe(false);
  });

  it('expires after 15 minutes', () => {
    const step = finishLogin(requested(), { tokenHash: 'token-1' }, 's', T0 + LOGIN_TTL_MS + 1);
    expect(step).toMatchObject({ ok: false, error: 'expired' });
    expect(step.account.pending).toBeNull();
  });

  it('locks after too many wrong codes, even for the right one', () => {
    let account = requested();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const step = finishLogin(account, { codeHash: 'nope' }, 's', T0 + i);
      expect(step).toMatchObject({ ok: false, error: 'wrong-code' });
      account = step.account;
    }
    expect(finishLogin(account, { codeHash: 'code-1' }, 's', T0 + 99)).toMatchObject({ ok: false, error: 'locked' });
    expect(hasSession(account, 's', T0 + 100)).toBe(false);
  });

  it('a new email replaces the old link and code', () => {
    const second = startLogin(requested(), hashes(2), T0 + MIN_SEND_GAP_MS);
    if (!second.ok) throw new Error(second.error);
    expect(finishLogin(second.account, { tokenHash: 'token-1' }, 's', T0 + MIN_SEND_GAP_MS + 1).ok).toBe(false);
    expect(finishLogin(second.account, { tokenHash: 'token-2' }, 's', T0 + MIN_SEND_GAP_MS + 1).ok).toBe(true);
  });

  it('rate limits sign-in emails', () => {
    let account = requested();
    expect(startLogin(account, hashes(2), T0 + MIN_SEND_GAP_MS - 1)).toMatchObject({ ok: false, error: 'too-soon' });
    let now = T0;
    for (let i = 1; i < MAX_SENDS_PER_HOUR; i++) {
      now += MIN_SEND_GAP_MS;
      const step = startLogin(account, hashes(i + 1), now);
      if (!step.ok) throw new Error(step.error);
      account = step.account;
    }
    expect(startLogin(account, hashes(99), now + MIN_SEND_GAP_MS)).toMatchObject({ ok: false, error: 'too-many' });
    expect(startLogin(account, hashes(99), T0 + 61 * 60 * 1000).ok).toBe(true);
  });
});

describe('sessions', () => {
  it('last about six months and can be ended', () => {
    const account = signedIn();
    expect(hasSession(account, 'session-1', T0 + SESSION_TTL_MS)).toBe(true);
    expect(hasSession(account, 'session-1', T0 + SESSION_TTL_MS + 2000)).toBe(false);
    expect(hasSession(account, 'other', T0)).toBe(false);
    expect(hasSession(null, 'session-1', T0)).toBe(false);
    expect(hasSession(endSession(account, 'session-1'), 'session-1', T0 + 2000)).toBe(false);
  });

  it('keeps several phones signed in, up to a limit', () => {
    let account = signedIn();
    let now = T0 + 1000;
    for (let i = 2; i <= MAX_SESSIONS + 3; i++) {
      now += MIN_SEND_GAP_MS * 20;
      const started = startLogin(account, hashes(i), now);
      if (!started.ok) throw new Error(started.error);
      const done = finishLogin(started.account, { tokenHash: `token-${i}` }, `session-${i}`, now);
      if (!done.ok) throw new Error(done.error);
      account = done.account;
    }
    expect(Object.keys(account.sessions)).toHaveLength(MAX_SESSIONS);
    expect(hasSession(account, `session-${MAX_SESSIONS + 3}`, now)).toBe(true);
    expect(hasSession(account, 'session-1', now)).toBe(false);
  });
});

describe('lifetime record', () => {
  it('adds up, ignoring junk and negatives', () => {
    const stats = addStats(emptyStats(), { smuggled: 2, seized: 1 });
    expect(addStats(stats, { smuggled: 3, getaways: 1, seized: -5, busts: Number.NaN, ...({ hacks: 9 } as object) })).toEqual({
      smuggled: 5, seized: 1, busts: 0, wrongCalls: 0, getaways: 1, games: 0,
    });
  });

  it('counts a client batch once and caps what it can claim', () => {
    let account = signedIn();
    account = recordStats(account, { smuggled: 4 }, 'batch-a', MAX_REPORTED_DELTA);
    expect(recordStats(account, { smuggled: 4 }, 'batch-a', MAX_REPORTED_DELTA)).toBe(account);
    account = recordStats(account, { smuggled: 1_000_000 }, 'batch-b', MAX_REPORTED_DELTA);
    expect(account.stats.smuggled).toBe(4 + MAX_REPORTED_DELTA);
    // Server awards have no batch id and no cap.
    account = recordStats(account, { getaways: 1, games: 1 });
    expect(publicAccount(account).stats).toMatchObject({ getaways: 1, games: 1 });
  });

  it('exposes only email, name and stats', () => {
    const account = rename(signedIn(), '  Sticky   Pete  ');
    expect(publicAccount(account)).toEqual({ email: 'ada@example.com', name: 'Sticky Pete', stats: emptyStats() });
    expect(JSON.stringify(publicAccount(account))).not.toContain('session-1');
  });
});

describe('rooms saved on the account', () => {
  it('keeps one entry per room, newest first, capped and pruned', async () => {
    const { withRoom, withoutRoom, MAX_SAVED_ROOMS } = await import('../src/shared/account');
    const day = 24 * 60 * 60 * 1000;
    let rooms = withRoom([], 'AAAA', 1000);
    rooms = withRoom(rooms, 'BBBB', 2000);
    rooms = withRoom(rooms, 'AAAA', 3000);
    expect(rooms.map((r) => r.code)).toEqual(['AAAA', 'BBBB']);
    expect(withoutRoom(rooms, 'AAAA').map((r) => r.code)).toEqual(['BBBB']);
    expect(withRoom(rooms, 'CCCC', 3000 + 31 * day).map((r) => r.code)).toEqual(['CCCC']);
    let many: ReturnType<typeof withRoom> = [];
    for (let i = 0; i < MAX_SAVED_ROOMS + 5; i++) many = withRoom(many, `R${i}`, 5000 + i);
    expect(many).toHaveLength(MAX_SAVED_ROOMS);
  });
});
