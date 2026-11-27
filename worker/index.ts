/**
 * Smuggled Phrases backend.
 *
 * The Worker serves the built PWA (static assets), routes
 * /api/rooms/:code/ws to the room's Durable Object, and exposes the small
 * account API (/api/auth/*, /api/me) backed by one Durable Object per email.
 *
 * Rooms: The object holds the
 * authoritative Room (see src/shared/room.ts), persists it on every change and
 * uses hibernating WebSockets, so an idle room costs nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { normalizeCode } from '../src/shared/prng';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/shared/protocol';
import { handleMessage, moveSeat, viewFor, type Room } from '../src/shared/room';

import { isValidEmail, normalizeEmail } from '../src/shared/account';
import { accountKey, AccountObject, sha256, splitCredential } from './accounts';
import type { MailEnv } from './mail';

export { AccountObject };

interface Env extends MailEnv {
  ROOMS: DurableObjectNamespace<RoomObject>;
  ACCOUNTS: DurableObjectNamespace<AccountObject>;
  ASSETS: Fetcher;
  /** Optional: the public origin to put in sign-in links. Defaults to the request's origin. */
  APP_ORIGIN?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

const ERROR_STATUS: Record<string, number> = { 'too-soon': 429, 'too-many': 429, locked: 429, 'email-not-configured': 503, 'email-failed': 502 };

/** The account API. Every route answers JSON: { ok: true, ... } or { ok: false, error }. */
async function accountApi(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const account = (key: string) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(key));
  let body: Record<string, unknown> = {};
  if (request.method === 'POST') {
    try {
      const text = await request.text();
      if (text.length > 4096) return json({ ok: false, error: 'bad-request' }, 413);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json({ ok: false, error: 'bad-request' }, 400);
    }
  }
  const fail = (error: string) => json({ ok: false, error }, ERROR_STATUS[error] ?? 400);

  if (path === '/api/auth/request' && request.method === 'POST') {
    const email = normalizeEmail(String(body.email ?? ''));
    if (!isValidEmail(email)) return fail('bad-email');
    const key = await accountKey(email);
    // Never build the link from a caller-supplied origin in production: that would let another
    // site have our email deliver a working sign-in token to its own page.
    const devOrigin = env.DEV_MAGIC_LINKS === 'true' ? request.headers.get('Origin') : null;
    const origin = env.APP_ORIGIN || devOrigin || new URL(request.url).origin;
    const result = await account(key).requestLogin(email, key, origin.replace(/\/$/, ''));
    return result.ok ? json(result) : fail(result.error);
  }

  if (path === '/api/auth/verify' && request.method === 'POST') {
    // Either the token from the link ("<key>.<token>") or the email plus the typed code.
    const fromLink = splitCredential(body.token);
    const key = fromLink?.key ?? (typeof body.email === 'string' && isValidEmail(normalizeEmail(body.email)) ? await accountKey(body.email) : null);
    if (!key) return fail('no-login');
    const result = await account(key).completeLogin(key, fromLink ? { token: fromLink.secret } : { code: String(body.code ?? '') });
    return result.ok ? json(result) : fail(result.error);
  }

  const credential = splitCredential((request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!credential) return json({ ok: false, error: 'not-signed-in' }, 401);
  const stub = account(credential.key);
  const reply = (me: unknown) => (me ? json({ ok: true, account: me }) : json({ ok: false, error: 'not-signed-in' }, 401));

  if (path === '/api/me' && request.method === 'GET') return reply(await stub.me(credential.secret));
  if (path === '/api/me' && request.method === 'POST') return reply(await stub.setName(credential.secret, String(body.name ?? '')));
  if (path === '/api/me/stats' && request.method === 'POST') {
    if (typeof body.batch !== 'string' || !body.batch || typeof body.delta !== 'object' || !body.delta) return fail('bad-request');
    return reply(await stub.report(credential.secret, body.delta as Record<string, number>, body.batch));
  }
  if (path === '/api/auth/signout' && request.method === 'POST') {
    await stub.signOut(credential.secret);
    return json({ ok: true });
  }
  return json({ ok: false, error: 'not-found' }, 404);
}

/** Rooms are deleted after this long with no activity. */
const ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 2048;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (match) {
      const code = normalizeCode(match[1]);
      if (!code) return new Response('Bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const headers = new Headers(request.headers);
      headers.set('X-Room-Code', code);
      return stub.fetch(new Request(request, { headers }));
    }
    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/me')) return accountApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  deviceId: string;
}

export class RoomObject extends DurableObject<Env> {
  private room: Room | null | undefined;
  private code = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer heartbeats without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const code = request.headers.get('X-Room-Code') ?? '';
    await this.ctx.storage.put('code', code);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async load(): Promise<Room | null> {
    if (this.room === undefined) {
      this.room = (await this.ctx.storage.get<Room>('room')) ?? null;
      this.code = (await this.ctx.storage.get<string>('code')) ?? '';
    }
    return this.room;
  }

  private deviceOf(ws: WebSocket): string | null {
    return (ws.deserializeAttachment() as Attachment | null)?.deviceId ?? null;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  /** Sends every connected member their own view of the room. */
  private broadcast(room: Room, extra?: ServerMessage, exclude?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
    const connected = new Set(sockets.map((ws) => this.deviceOf(ws)).filter((d): d is string => !!d));
    const now = Date.now();
    for (const ws of sockets) {
      const deviceId = this.deviceOf(ws);
      const view = deviceId ? viewFor(room, deviceId, connected) : null;
      if (!view) continue;
      this.send(ws, { t: 'state', now, room: view });
      if (extra) this.send(ws, extra);
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: 'error', code: 'bad-message' });
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.send(ws, { t: 'error', code: 'bad-message' });

    let room = await this.load();
    const before = room;
    let deviceId = this.deviceOf(ws);

    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) return this.send(ws, { t: 'error', code: 'outdated' });
      if (typeof msg.deviceId !== 'string' || msg.deviceId.length < 16 || msg.deviceId.length > 64) {
        return this.send(ws, { t: 'error', code: 'bad-message' });
      }
      deviceId = msg.deviceId;
    }
    // Players prove who they are with their session; the room remembers the account.
    let verifiedAccount: string | null = null;
    if (msg.t === 'hello') {
      const credential = splitCredential(msg.session);
      if (credential) {
        try {
          const me = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(credential.key)).me(credential.secret);
          if (me) verifiedAccount = credential.key;
        } catch {
          // Account service unavailable: not a refusal. Drop the socket so the phone retries.
          return ws.close(1013, 'try again');
        }
      }
      // Every seat in a room belongs to a signed-in player.
      if (!verifiedAccount) return this.send(ws, { t: 'error', code: 'sign-in-required' });
    }
    if (!deviceId) return this.send(ws, { t: 'error', code: 'bad-message', detail: 'hello first' });
    const accountStub = (key: string) => this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(key));

    // The same account on a new device picks up its seat (hand, score and name) from the old one.
    let movedFrom: string | null = null;
    if (msg.t === 'hello' && verifiedAccount) {
      if (!room && !msg.create) this.ctx.waitUntil(accountStub(verifiedAccount).leftRoom(this.code).catch(() => {}));
      if (room) {
        const moved = moveSeat(room, verifiedAccount, deviceId);
        if (moved.from) {
          room = moved.room;
          movedFrom = moved.from;
          const seat = room.members.find((m) => m.deviceId === deviceId);
          if (seat) msg = { ...msg, name: seat.name };
        }
      }
    }

    let outcome;
    try {
      outcome = handleMessage(room, deviceId, msg, Date.now(), Math.random, this.code);
    } catch {
      return this.send(ws, { t: 'error', code: 'bad-message' });
    }
    if (outcome.error) return this.send(ws, { t: 'error', code: outcome.error.code, detail: outcome.error.detail });

    if (msg.t === 'hello') {
      // One live socket per device: a reconnect replaces the stale one.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && this.deviceOf(other) === deviceId) other.close(4000, 'replaced');
      }
      ws.serializeAttachment({ deviceId } satisfies Attachment);
    }

    for (const dropped of outcome.drop ?? []) {
      for (const other of this.ctx.getWebSockets()) {
        if (this.deviceOf(other) === dropped) {
          this.send(other, { t: 'error', code: 'removed' });
          other.serializeAttachment(null);
          other.close(4001, 'removed');
        }
      }
    }

    if (movedFrom) {
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && this.deviceOf(other) === movedFrom) {
          this.send(other, { t: 'error', code: 'moved' });
          other.serializeAttachment(null);
          other.close(4002, 'moved');
        }
      }
    }

    if (msg.t === 'hello' && outcome.room) {
      const member = outcome.room.members.find((m) => m.deviceId === deviceId);
      if (member) {
        if (verifiedAccount) member.account = verifiedAccount;
        else delete member.account;
      }
      // The account remembers the room, so the game shows up on the player's other devices.
      if (member && verifiedAccount) this.ctx.waitUntil(accountStub(verifiedAccount).joinedRoom(this.code).catch(() => {}));
    }

    // Anyone who lost their seat here (left, removed, or the room emptied) forgets the room.
    const seated = new Set((outcome.room?.members ?? []).map((m) => m.account));
    for (const key of new Set((before?.members ?? []).map((m) => m.account))) {
      if (key && !seated.has(key)) this.ctx.waitUntil(accountStub(key).leftRoom(this.code).catch(() => {}));
    }

    // Count progress for signed-in players. Done here, on the server, so it cannot be faked.
    for (const award of outcome.awards ?? []) {
      const key = (outcome.room ?? room)?.members.find((m) => m.id === award.memberId)?.account;
      if (key) this.ctx.waitUntil(this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(key)).award(award.delta).catch(() => {}));
    }

    this.room = outcome.room;
    if (outcome.room) {
      await this.ctx.storage.put('room', outcome.room);
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      this.broadcast(outcome.room, outcome.news.length ? { t: 'news', items: outcome.news } : undefined);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const room = await this.load();
    if (room && this.deviceOf(ws)) this.broadcast(room, undefined, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Expire abandoned rooms. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    const room = await this.load();
    for (const key of new Set((room?.members ?? []).map((m) => m.account))) {
      if (key) await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(key)).leftRoom(this.code).catch(() => {});
    }
    this.room = null;
    await this.ctx.storage.deleteAll();
  }
}
