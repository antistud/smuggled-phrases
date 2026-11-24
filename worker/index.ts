/**
 * Smuggled Phrases backend: one Durable Object per room.
 *
 * The Worker serves the built PWA (static assets) and routes
 * /api/rooms/:code/ws to the room's Durable Object. The object holds the
 * authoritative Room (see src/shared/room.ts), persists it on every change and
 * uses hibernating WebSockets, so an idle room costs nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { normalizeCode } from '../src/shared/prng';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/shared/protocol';
import { handleMessage, viewFor, type Room } from '../src/shared/room';

interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
  ASSETS: Fetcher;
}

/** Rooms are deleted after this long with no activity. */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
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

    const room = await this.load();
    let deviceId = this.deviceOf(ws);

    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) return this.send(ws, { t: 'error', code: 'outdated' });
      if (typeof msg.deviceId !== 'string' || msg.deviceId.length < 16 || msg.deviceId.length > 64) {
        return this.send(ws, { t: 'error', code: 'bad-message' });
      }
      deviceId = msg.deviceId;
    }
    if (!deviceId) return this.send(ws, { t: 'error', code: 'bad-message', detail: 'hello first' });

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
    this.room = null;
    await this.ctx.storage.deleteAll();
  }
}
