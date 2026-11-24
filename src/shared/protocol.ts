/** Wire protocol between the app and a room. JSON over one WebSocket. */
import type { Phrase } from './packs';
import type { Accusation, Card } from './rules';

export const PROTOCOL_VERSION = 1;
export const MAX_ROOM_PLAYERS = 12;
export const MAX_NAME_LENGTH = 16;

export type ClientMessage =
  /** First message on every (re)connection. `create` opens a new room. */
  | { t: 'hello'; v: number; deviceId: string; name: string; create?: { packs: string[] } }
  | { t: 'start' }
  | { t: 'declare'; cardId: string }
  | { t: 'undeclare'; cardId: string }
  | { t: 'smuggle'; cardId: string }
  | { t: 'accuse'; accusedId: string }
  | { t: 'resolve'; cardId: string | null }
  | { t: 'cancelAccusation' }
  | { t: 'swap'; cardId: string | null }
  | { t: 'again' }
  | { t: 'kick'; playerId: string }
  | { t: 'leave' };

export type RoomPhase = 'lobby' | 'playing' | 'over';

export interface ScoreRow {
  id: string;
  name: string;
  connected: boolean;
  cards: number;
  badges: number;
  smuggled: number;
  seized: number;
}

export interface RoomView {
  code: string;
  phase: RoomPhase;
  hostId: string;
  packs: string[];
  pileCount: number;
  players: ScoreRow[];
  you: {
    id: string;
    hand: Card[];
    badges: number;
    swapCredits: number;
    smuggled: Phrase[];
    seized: number;
  };
  accusation: Accusation | null;
  winner: { id: string; name: string; phrases: Phrase[] } | null;
}

/** Things worth announcing on every phone. Names are resolved by the server. */
export type Announcement =
  | { kind: 'smuggled'; name: string; text: string }
  | { kind: 'seized'; name: string; by: string | null; text: string }
  | { kind: 'wrongCall'; name: string; accused: string | null; badgesLeft: number }
  | { kind: 'cancelled' }
  | { kind: 'joined'; name: string }
  | { kind: 'left'; name: string };

export type ServerErrorCode =
  | 'room-not-found'
  | 'room-taken'
  | 'room-full'
  | 'bad-message'
  | 'not-host'
  | 'not-in-room'
  | 'need-players'
  | 'wrong-phase'
  | 'removed'
  | 'outdated'
  | 'rule';

export type ServerMessage =
  | { t: 'state'; now: number; room: RoomView }
  | { t: 'news'; items: Announcement[] }
  | { t: 'error'; code: ServerErrorCode; detail?: string };
