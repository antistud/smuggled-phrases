/**
 * The signed-in account on this phone: email sign-in, the display name and the
 * lifetime record kept on the server. Everything degrades to "guest" when
 * signed out or offline; the game never depends on it.
 */
import { addStats, emptyStats, type PublicAccount, type StatDelta } from '../shared/account';
import { load, save } from './storage';

interface Saved {
  session: string;
  account: PublicAccount;
}
interface QueuedBatch {
  batch: string;
  delta: StatDelta;
}

const ERRORS: Record<string, string> = {
  'bad-email': 'That does not look like an email address.',
  'too-soon': 'We just sent one. Give it a minute before asking again.',
  'too-many': 'Too many sign-in emails for now. Try again in an hour.',
  'no-login': 'No sign-in is waiting for that address. Ask for a new email.',
  expired: 'That link or code has expired. Ask for a new one.',
  'wrong-code': 'That code is not right.',
  locked: 'Too many wrong tries. Ask for a new email.',
  'email-not-configured': 'Email sign-in is not set up on this server yet.',
  'email-failed': 'The email could not be sent. Try again shortly.',
  offline: 'You seem to be offline.',
};

let saved = load<Saved>('account');
const listeners = new Set<() => void>();

function set(next: Saved | null): void {
  saved = next;
  save('account', next);
  listeners.forEach((fn) => fn());
}

function apiBase(): string {
  return ((import.meta.env.VITE_API_BASE as string | undefined) || '').replace(/\/$/, '');
}

type Reply = { ok: true; [key: string]: any } | { ok: false; error: string };

async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Reply> {
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (saved) headers.Authorization = `Bearer ${saved.session}`;
    const res = await fetch(`${apiBase()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json()) as Reply;
    // The server no longer knows this session: sign out locally.
    if (res.status === 401 && saved) set(null);
    return data;
  } catch {
    return { ok: false, error: 'offline' };
  }
}

export const errorText = (code: string): string => ERRORS[code] ?? 'Something went wrong. Try again.';

function uid(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const account = {
  get current(): PublicAccount | null {
    return saved?.account ?? null;
  },
  /** Sent to a room so the server can count this player's progress. */
  get session(): string | undefined {
    return saved?.session;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Step one. In local development the server hands the link and code straight back. */
  async requestLink(email: string): Promise<{ ok: true; dev?: { link: string; code: string } } | { ok: false; error: string }> {
    const reply = await call('/api/auth/request', { email });
    return reply.ok ? { ok: true, dev: reply.dev } : reply;
  },

  /** Step two, from the emailed link (`token`) or the typed code. */
  async verify(proof: { token: string } | { email: string; code: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const reply = await call('/api/auth/verify', proof);
    if (!reply.ok) return reply;
    set({ session: reply.session, account: reply.account });
    await this.adoptLocalProgress();
    return { ok: true };
  },

  async refresh(): Promise<void> {
    if (!saved) return;
    await this.flush();
    const reply = await call('/api/me');
    if (reply.ok && saved) set({ ...saved, account: reply.account });
  },

  async setName(name: string): Promise<void> {
    if (!saved) return;
    set({ ...saved, account: { ...saved.account, name } });
    const reply = await call('/api/me', { name });
    if (reply.ok && saved) set({ ...saved, account: reply.account });
  },

  async signOut(): Promise<void> {
    if (!saved) return;
    await call('/api/auth/signout', {});
    set(null);
  },

  /**
   * Progress from a game the server did not see (offline mode). Shown at once,
   * queued locally, and sent when there is a connection.
   */
  report(delta: StatDelta): void {
    if (!saved) return;
    const queue = load<QueuedBatch[]>('statqueue') ?? [];
    queue.push({ batch: uid(), delta });
    save('statqueue', queue);
    set({ ...saved, account: { ...saved.account, stats: addStats(saved.account.stats, delta) } });
    void this.flush();
  },

  async flush(): Promise<void> {
    let queue = load<QueuedBatch[]>('statqueue') ?? [];
    while (saved && queue.length) {
      const reply = await call('/api/me/stats', queue[0]);
      if (!reply.ok && reply.error === 'offline') return;
      // Sent, or rejected for good: either way do not retry it forever.
      queue = (load<QueuedBatch[]>('statqueue') ?? []).filter((b) => b.batch !== queue[0].batch);
      save('statqueue', queue);
      if (reply.ok && saved) set({ ...saved, account: reply.account });
    }
  },

  /** On first sign-in, move the guest rap sheet from this phone onto the account. */
  async adoptLocalProgress(): Promise<void> {
    const local = load<StatDelta>('rapsheet');
    if (!saved || !local) return;
    const total = Object.values(local).reduce((n: number, v) => n + (Number(v) || 0), 0);
    save('rapsheet', null);
    if (total > 0) this.report({ ...emptyStats(), ...local });
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void account.flush());
}
