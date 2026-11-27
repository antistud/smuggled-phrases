/**
 * A Session is one game as seen from this phone. The UI talks to this interface
 * only; OfflineSession runs the rules engine locally, SyncSession mirrors a room.
 */
import { createOfflineGame, manifestNumber, OFFLINE_PLAYER_ID } from '../shared/deal';
import type { Phrase } from '../shared/packs';
import { randomCode } from '../shared/prng';
import {
  PROTOCOL_VERSION,
  type Announcement,
  type ClientMessage,
  type RoomOptions,
  type RoomPhase,
  type RoomView,
  type ScoreRow,
  type ServerMessage,
} from '../shared/protocol';
import { applyAction, type Accusation, type Action, type Card, type Game } from '../shared/rules';
import { DEFAULT_SETTINGS, normalizeSettings, type GameSettings } from '../shared/settings';
import { account } from './account';
import { deviceId, load, save } from './storage';

export type Connection = 'local' | 'online' | 'connecting';

export interface SessionState {
  mode: 'offline' | 'sync';
  code: string;
  packs: string[];
  settings: GameSettings;
  phase: RoomPhase;
  connection: Connection;
  you: { id: string; name: string; hand: Card[]; badges: number; swapCredits: number; smuggled: Phrase[]; seized: number; catchphrase: Card | null; catchCount: number };
  players: ScoreRow[];
  hostId: string | null;
  pileCount: number;
  accusation: Accusation | null;
  winner: { id: string; name: string; phrases: Phrase[] } | null;
  /** Offline only. */
  playerNumber?: number;
  manifest?: string;
  /** Set when the session cannot continue (room gone, removed, ...). */
  fatal?: string;
}

type Listener = () => void;

// ------------------------------------------------------------- saved games
// A phone can sit in several games at once. Each one is saved under its own id
// (not its room code: a synced room's code can change while it is being created).

interface SavedGame {
  id: string;
  kind: 'offline' | 'sync';
  data: unknown;
}

function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function savedGames(): SavedGame[] {
  const list = load<SavedGame[]>('games');
  return Array.isArray(list) ? list.filter((g) => g && typeof g.id === 'string' && g.data) : [];
}

function putGame(game: SavedGame): void {
  const list = savedGames();
  const at = list.findIndex((g) => g.id === game.id);
  if (at >= 0) list[at] = game;
  else list.push(game);
  save('games', list);
}

function dropGame(id: string): void {
  save('games', savedGames().filter((g) => g.id !== id));
}

/** Remembers which game to open first next time. */
export function rememberCurrent(id: string | null): void {
  save('current', id);
}

export abstract class Session {
  abstract state: SessionState;
  /** Stable for the life of this game on this phone. */
  abstract readonly id: string;
  private listeners = new Set<Listener>();
  private newsListeners = new Set<(a: Announcement) => void>();
  private errorListeners = new Set<(message: string) => void>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onNews(fn: (a: Announcement) => void): () => void {
    this.newsListeners.add(fn);
    return () => this.newsListeners.delete(fn);
  }
  onError(fn: (message: string) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }
  protected emit(): void {
    this.listeners.forEach((fn) => fn());
  }
  protected emitNews(a: Announcement): void {
    this.newsListeners.forEach((fn) => fn(a));
  }
  protected emitError(message: string): void {
    this.errorListeners.forEach((fn) => fn(message));
  }

  /** Current time on the clock the card timestamps were taken from. */
  now(): number {
    return Date.now();
  }

  abstract declare(cardId: string): void;
  abstract undeclare(cardId: string): void;
  abstract smuggle(cardId: string): void;
  abstract swap(cardId: string | null): void;
  abstract leave(): void;
  /** Stop timers and sockets without leaving the game. */
  dispose(): void {}

  // Offline (honor system) only.
  /** Own up to being caught. Synced games can name who caught you. */
  caught(_cardId: string, _catcherId?: string): void {}
  caughtSomeone(): void {}
  wrongCall(): void {}
  // Synced only.
  accuse(_playerId: string): void {}
  resolve(_cardId: string | null): void {}
  cancelAccusation(): void {}
  start(): void {}
  again(): void {}
  rename(_name: string): void {}
  configure(_options: RoomOptions): void {}
  kick(_playerId: string): void {}
}

// ------------------------------------------------------------------ offline

interface OfflineSave {
  code: string;
  packs: string[];
  settings?: GameSettings;
  playerNumber: number;
  game: Game;
}

export class OfflineSession extends Session {
  state: SessionState;
  readonly id: string;
  private data: OfflineSave;

  private constructor(id: string, data: OfflineSave) {
    super();
    this.id = id;
    this.data = data;
    this.state = this.view();
  }

  static create(code: string, packs: string[], playerNumber: number, settings: GameSettings): OfflineSession {
    const session = new OfflineSession(newId(), { code, packs, settings, playerNumber, game: createOfflineGame(code, packs, playerNumber, settings) });
    session.persist();
    return session;
  }

  static restore(id: string, data: OfflineSave | null | undefined): OfflineSession | null {
    return data?.game?.players?.[OFFLINE_PLAYER_ID] ? new OfflineSession(id, data) : null;
  }

  private persist(): void {
    putGame({ id: this.id, kind: 'offline', data: this.data });
  }

  private view(): SessionState {
    const { code, packs, playerNumber, game } = this.data;
    const settings = normalizeSettings(this.data.settings);
    const me = game.players[OFFLINE_PLAYER_ID];
    const name = `Player ${playerNumber}`;
    return {
      mode: 'offline',
      code,
      packs,
      settings,
      phase: game.winnerId ? 'over' : 'playing',
      connection: 'local',
      you: { id: me.id, name, hand: me.hand, badges: me.badges, swapCredits: me.swapCredits, smuggled: me.smuggled, seized: me.seized.length, catchphrase: me.catchphrase ?? null, catchCount: me.catchCount ?? 0 },
      players: [{ id: me.id, name, connected: true, cards: me.hand.length, badges: me.badges, smuggled: me.smuggled.length, seized: me.seized.length, catchCount: me.catchCount ?? 0 }],
      hostId: null,
      pileCount: game.pile.length,
      accusation: null,
      winner: game.winnerId ? { id: me.id, name, phrases: me.smuggled } : null,
      playerNumber,
      manifest: manifestNumber(code, packs, settings),
    };
  }

  private act(action: Action): void {
    const result = applyAction(this.data.game, action);
    if (!result.ok) {
      if (result.error === 'pile-empty') this.emitError('Your crate is empty: no phrases left to draw.');
      return;
    }
    this.data.game = result.game;
    this.persist();
    this.state = this.view();
    this.emit();
  }

  declare(cardId: string) { this.act({ type: 'declare', playerId: OFFLINE_PLAYER_ID, cardId, now: Date.now() }); }
  undeclare(cardId: string) { this.act({ type: 'undeclare', playerId: OFFLINE_PLAYER_ID, cardId }); }
  smuggle(cardId: string) { this.act({ type: 'smuggle', playerId: OFFLINE_PLAYER_ID, cardId, now: Date.now() }); }
  caught(cardId: string) { this.act({ type: 'caught', playerId: OFFLINE_PLAYER_ID, cardId }); }
  caughtSomeone() { this.act({ type: 'grantSwap', playerId: OFFLINE_PLAYER_ID }); }
  wrongCall() { this.act({ type: 'wrongCall', playerId: OFFLINE_PLAYER_ID }); }
  swap(cardId: string | null) { this.act({ type: 'swap', playerId: OFFLINE_PLAYER_ID, cardId }); }
  leave() {
    dropGame(this.id);
  }
}

// ------------------------------------------------------------------- synced

interface SyncSave {
  code: string;
  name: string;
  /** Last view from the server, so a reload shows the hand before the socket is back. */
  view: RoomView | null;
  /** serverNow - Date.now() when `view` arrived. */
  offset: number;
}

const FATAL: Record<string, string> = {
  'room-not-found': 'That room does not exist (or has closed).',
  'room-full': 'That room is full.',
  removed: 'You were removed from the room.',
  outdated: 'This app is out of date. Reload to update.',
};

const RULE_MESSAGES: Record<string, string> = {
  'no-badges': 'No badges left: you cannot call anyone.',
  'accusation-pending': 'Hold on, a call is being settled.',
  'timer-running': 'Not yet! The 30 seconds are not up.',
  'timer-expired': 'Too late: that phrase had already cleared.',
  'pile-empty': 'The crate is empty: no phrases left to draw.',
  'need-players': 'You need at least two smugglers.',
};

function apiBase(): string {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) || location.origin;
  return base.replace(/^http/, 'ws').replace(/\/$/, '');
}

export class SyncSession extends Session {
  state: SessionState;
  readonly id: string;
  private data: SyncSave;
  private ws: WebSocket | null = null;
  private create: RoomOptions | null;
  private closed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;

  private constructor(id: string, data: SyncSave, create: RoomOptions | null) {
    super();
    this.id = id;
    this.data = data;
    this.create = create;
    this.state = this.view('connecting');
    document.addEventListener('visibilitychange', this.onWake);
    window.addEventListener('online', this.onWake);
    window.addEventListener('pageshow', this.onWake);
    this.connect();
  }

  static host(name: string, packs: string[], settings: GameSettings): SyncSession {
    return new SyncSession(newId(), { code: randomCode(), name, view: null, offset: 0 }, { packs, ...settings });
  }
  static join(code: string, name: string): SyncSession {
    return new SyncSession(newId(), { code, name, view: null, offset: 0 }, null);
  }
  static restore(id: string, data: SyncSave | null | undefined): SyncSession | null {
    return data?.code ? new SyncSession(id, data, null) : null;
  }

  now(): number {
    return Date.now() + this.data.offset;
  }

  private view(connection: Connection, fatal?: string): SessionState {
    const v = this.data.view;
    const me = v?.players.find((p) => p.id === v.you.id);
    return {
      mode: 'sync',
      code: this.data.code,
      packs: v?.packs ?? this.create?.packs ?? [],
      settings: normalizeSettings(v?.settings ?? this.create ?? DEFAULT_SETTINGS),
      phase: v?.phase ?? 'lobby',
      connection,
      you: {
        id: v?.you.id ?? '',
        name: me?.name ?? this.data.name,
        hand: v?.you.hand ?? [],
        badges: v?.you.badges ?? 0,
        swapCredits: v?.you.swapCredits ?? 0,
        smuggled: v?.you.smuggled ?? [],
        seized: v?.you.seized ?? 0,
        catchphrase: v?.you.catchphrase ?? null,
        catchCount: v?.you.catchCount ?? 0,
      },
      players: v?.players ?? [],
      hostId: v?.hostId ?? null,
      pileCount: v?.pileCount ?? 0,
      accusation: v?.accusation ?? null,
      winner: v?.winner ?? null,
      fatal,
    };
  }

  private update(connection: Connection, fatal?: string): void {
    this.state = this.view(connection, fatal);
    this.emit();
  }

  private connect(): void {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.teardownSocket();
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${apiBase()}/api/rooms/${this.data.code}/ws`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const hello: ClientMessage = { t: 'hello', v: PROTOCOL_VERSION, deviceId: deviceId(), name: this.data.name, session: account.session };
      if (this.create) hello.create = this.create;
      ws.send(JSON.stringify(hello));
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (ev.data === 'pong') {
        clearTimeout(this.pongTimer);
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.closed || this.state.fatal) return;
      this.failures += 1;
      // Never got in at all: tell the user rather than spin forever.
      if (!this.data.view && this.failures >= 3) {
        this.fail('Could not reach the game server. Check your connection, or play offline.');
        return;
      }
      this.update('connecting');
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.t === 'state') {
      this.retry = 0;
      this.failures = 0;
      this.create = null;
      this.data.view = msg.room;
      this.data.offset = msg.now - Date.now();
      putGame({ id: this.id, kind: 'sync', data: this.data });
      this.update('online');
    } else if (msg.t === 'news') {
      msg.items.forEach((item) => this.emitNews(item));
    } else if (msg.t === 'error') {
      if (msg.code === 'room-taken' && this.create) {
        // Code collision while creating: roll a new one and try again.
        this.data.code = randomCode();
        this.connect();
      } else if (msg.code === 'not-in-room' && this.data.view) {
        this.fail('You are no longer in this room.');
      } else if (FATAL[msg.code]) {
        this.fail(FATAL[msg.code]);
      } else if (msg.code === 'rule') {
        const text = RULE_MESSAGES[msg.detail ?? ''];
        if (text) this.emitError(text);
      } else if (RULE_MESSAGES[msg.code]) {
        this.emitError(RULE_MESSAGES[msg.code]);
      }
    }
  }

  private fail(reason: string): void {
    this.closed = true;
    this.teardownSocket();
    dropGame(this.id);
    this.update('connecting', reason);
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    const delay = Math.min(5000, 400 * 2 ** this.retry) + Math.random() * 300;
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.ping(), 20_000);
  }
  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }
  /** A socket can look open long after a sleeping phone lost it; prove it is alive. */
  private ping(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send('ping');
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      if (this.ws === ws) this.connect();
    }, 5000);
  }

  private onWake = (): void => {
    if (this.closed || document.visibilityState !== 'visible') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ping();
    else if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) {
      this.retry = 0;
      this.connect();
    }
  };

  private teardownSocket(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.emitError('Reconnecting… try again in a moment.');
  }

  declare(cardId: string) { this.send({ t: 'declare', cardId }); }
  undeclare(cardId: string) { this.send({ t: 'undeclare', cardId }); }
  smuggle(cardId: string) { this.send({ t: 'smuggle', cardId }); }
  caught(cardId: string, catcherId?: string) { this.send({ t: 'caught', cardId, ...(catcherId ? { catcherId } : {}) }); }
  swap(cardId: string | null) { this.send({ t: 'swap', cardId }); }
  accuse(playerId: string) { this.send({ t: 'accuse', accusedId: playerId }); }
  resolve(cardId: string | null) { this.send({ t: 'resolve', cardId }); }
  cancelAccusation() { this.send({ t: 'cancelAccusation' }); }
  start() { this.send({ t: 'start' }); }
  again() { this.send({ t: 'again' }); }
  rename(name: string) {
    // Remembered so a reconnect does not put the old name back.
    this.data.name = name;
    putGame({ id: this.id, kind: 'sync', data: this.data });
    save('name', name);
    this.send({ t: 'rename', name });
  }
  configure(options: RoomOptions) { this.send({ t: 'configure', options }); }
  kick(playerId: string) { this.send({ t: 'kick', playerId }); }

  leave() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'leave' } satisfies ClientMessage));
    dropGame(this.id);
    // Give the leave message a beat to flush before closing.
    setTimeout(() => this.dispose(), 150);
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    document.removeEventListener('visibilitychange', this.onWake);
    window.removeEventListener('online', this.onWake);
    window.removeEventListener('pageshow', this.onWake);
    this.teardownSocket();
  }
}

/** Before multi-game support there was one saved game of each kind. Carry them over. */
function migrateLegacy(): void {
  const offline = load<OfflineSave>('offline');
  const sync = load<SyncSave>('sync');
  const active = load<string>('active');
  if (!offline && !sync && !active) return;
  for (const [kind, data] of [['offline', offline], ['sync', sync]] as const) {
    if (!data) continue;
    const id = newId();
    putGame({ id, kind, data });
    if (active === kind) rememberCurrent(id);
  }
  save('offline', null);
  save('sync', null);
  save('active', null);
}

/** Every game this phone is in, and the one to open first. */
export function restoreSessions(): { sessions: Session[]; currentId: string | null } {
  migrateLegacy();
  const sessions: Session[] = [];
  for (const saved of savedGames()) {
    const session =
      saved.kind === 'offline' ? OfflineSession.restore(saved.id, saved.data as OfflineSave) : SyncSession.restore(saved.id, saved.data as SyncSave);
    if (session) sessions.push(session);
    else dropGame(saved.id);
  }
  const wanted = load<string>('current');
  const currentId = sessions.find((s) => s.id === wanted)?.id ?? sessions[0]?.id ?? null;
  return { sessions, currentId };
}
