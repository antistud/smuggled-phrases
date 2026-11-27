/**
 * One Durable Object per email address. It holds the account (see
 * src/shared/account.ts), verifies sign-ins and keeps the lifetime record.
 * Rooms call award() directly, so progress from synced games is counted by the
 * server and cannot be faked by a client.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  endSession,
  finishLogin,
  hasSession,
  isValidEmail,
  MAX_REPORTED_DELTA,
  newAccount,
  normalizeEmail,
  publicAccount,
  recordStats,
  rename,
  startLogin,
  type Account,
  type AccountError,
  type PublicAccount,
  type SavedRoom,
  type StatDelta,
  withoutRoom,
  withRoom,
} from '../src/shared/account';
import { sendLoginEmail, type MailEnv } from './mail';

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  // Rejection sampling so every 6-digit code is equally likely.
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_000_000);
  return String(n % 1_000_000).padStart(6, '0');
}

/** Accounts are addressed by a hash of the email, so the address never appears in a token or URL. */
export const accountKey = (email: string): Promise<string> => sha256(`smuggled-account|${normalizeEmail(email)}`);

/** A client credential is "<account key>.<secret>". */
export function splitCredential(value: unknown): { key: string; secret: string } | null {
  const match = typeof value === 'string' ? value.match(/^([0-9a-f]{64})\.([0-9a-f]{12,128})$/) : null;
  return match ? { key: match[1], secret: match[2] } : null;
}

export type ApiError = AccountError | 'email-not-configured' | 'email-failed';
export type LoginStarted = { ok: true; dev?: { link: string; code: string } } | { ok: false; error: ApiError };
export type LoginFinished = { ok: true; session: string; account: PublicAccount } | { ok: false; error: ApiError };

export class AccountObject extends DurableObject<MailEnv> {
  private account: Account | null | undefined;

  private async load(): Promise<Account | null> {
    if (this.account === undefined) this.account = (await this.ctx.storage.get<Account>('account')) ?? null;
    return this.account;
  }
  private async save(account: Account): Promise<void> {
    this.account = account;
    await this.ctx.storage.put('account', account);
  }
  private async rooms(): Promise<SavedRoom[]> {
    return (await this.ctx.storage.get<SavedRoom[]>('rooms')) ?? [];
  }
  /** What the signed-in client sees: the account plus the rooms it is seated in. */
  private async pub(account: Account): Promise<PublicAccount> {
    return { ...publicAccount(account), rooms: await this.rooms() };
  }

  /** Step one: email a link and a code. */
  async requestLogin(rawEmail: string, key: string, origin: string): Promise<LoginStarted> {
    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) return { ok: false, error: 'bad-email' };
    const token = randomToken();
    const code = randomCode();
    const current = (await this.load()) ?? newAccount(email, Date.now());
    const step = startLogin(current, { tokenHash: await sha256(token), codeHash: await sha256(`${key}|${code}`) }, Date.now());
    if (!step.ok) return { ok: false, error: step.error };
    const mail = await sendLoginEmail(this.env, email, `${origin}/?login=${key}.${token}`, code);
    if (!mail.sent && 'error' in mail) return { ok: false, error: mail.error };
    await this.save(step.account);
    return mail.sent ? { ok: true } : { ok: true, dev: mail.dev };
  }

  /** Step two: trade the link token or the typed code for a session. */
  async completeLogin(key: string, proof: { token?: string; code?: string }): Promise<LoginFinished> {
    const account = await this.load();
    if (!account) return { ok: false, error: 'no-login' };
    const secret = randomToken();
    const step = finishLogin(
      account,
      {
        tokenHash: proof.token ? await sha256(proof.token) : undefined,
        codeHash: proof.code ? await sha256(`${key}|${String(proof.code).replace(/\D/g, '')}`) : undefined,
      },
      await sha256(secret),
      Date.now(),
    );
    await this.save(step.account);
    if (!step.ok) return { ok: false, error: step.error };
    return { ok: true, session: `${key}.${secret}`, account: await this.pub(step.account) };
  }

  private async authed(secret: string): Promise<Account | null> {
    const account = await this.load();
    return hasSession(account, await sha256(secret), Date.now()) ? account : null;
  }

  async me(secret: string): Promise<PublicAccount | null> {
    const account = await this.authed(secret);
    return account ? this.pub(account) : null;
  }

  async setName(secret: string, name: string): Promise<PublicAccount | null> {
    const account = await this.authed(secret);
    if (!account) return null;
    const next = rename(account, name);
    await this.save(next);
    return this.pub(next);
  }

  /** Progress the client reports itself (offline games). Capped and idempotent. */
  async report(secret: string, delta: StatDelta, batchId: string): Promise<PublicAccount | null> {
    const account = await this.authed(secret);
    if (!account) return null;
    const next = recordStats(account, delta, String(batchId).slice(0, 64), MAX_REPORTED_DELTA);
    if (next !== account) await this.save(next);
    return this.pub(next);
  }

  async signOut(secret: string): Promise<void> {
    const account = await this.load();
    if (account) await this.save(endSession(account, await sha256(secret)));
  }

  /** Called by rooms only (never routed from the internet): server-counted progress. */
  async award(delta: StatDelta): Promise<void> {
    const account = await this.load();
    if (account?.verifiedAt) await this.save(recordStats(account, delta));
  }

  /** Called by rooms only: this account took (or came back to) a seat in a room. */
  async joinedRoom(code: string): Promise<void> {
    await this.ctx.storage.put('rooms', withRoom(await this.rooms(), code, Date.now()));
  }

  /** Called by rooms only: the seat is gone (left, removed, or the room closed). */
  async leftRoom(code: string): Promise<void> {
    const rooms = await this.rooms();
    if (rooms.some((r) => r.code === code)) await this.ctx.storage.put('rooms', withoutRoom(rooms, code));
  }
}
