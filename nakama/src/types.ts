/// <reference path="../node_modules/nakama-runtime/index.d.ts" />

export type PresenceRef = {
  userId: string;
  sessionId: string;
  username: string;
  node?: string;
};

export type PlayerSeat = {
  userId: string;
  username: string;
  color: string;
  isConnected: boolean;
  joinedAt: string;
};

export type RoomRole = 'player' | 'spectator';

export type MatchMove = {
  playerId: string;
  edgeKey: string;
  createdAt: string;
  completedBoxes: string[];
  turnAfterMove: string | null;
};

export type SerializedState = {
  roomCode: string;
  gridSize: number;
  status: 'waiting' | 'active' | 'finished';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentTurnUserId: string | null;
  players: PlayerSeat[];
  spectators: PresenceRef[];
  edges: Record<string, string>;
  boxes: Record<string, string>;
  scores: Record<string, number>;
  moveLog: MatchMove[];
  winnerIds: string[];
  reconnectGraceSec: number;
};

export type RoomRecord = {
  roomCode: string;
  matchId: string;
  gridSize: number;
  status: SerializedState['status'];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  playerOrder: string[];
  snapshot: SerializedState;
  completedAt: string | null;
  winnerIds: string[];
};

export type MatchHistoryRecord = {
  roomCode: string;
  gridSize: number;
  startedAt: string | null;
  finishedAt: string;
  durationSec: number;
  moves: number;
  scores: Record<string, number>;
  winnerIds: string[];
  players: Array<{ userId: string; username: string; color: string }>;
  moveLog: MatchMove[];
};

export type MatchState = SerializedState & {
  presences: Record<string, nkruntime.Presence>;
  matchId: string;
};

export type EventPayload<T = unknown> = {
  type: string;
  data: T;
};

export type StatePayload = {
  matchId: string;
  snapshot: SerializedState;
};

export type EnsuredMatch = {
  room: RoomRecord;
  matchId: string;
};

export type JoinRoomPayload = {
  roomCode: string;
  username?: string;
  spectator?: boolean;
};

export type CreateRoomPayload = {
  username?: string;
  gridSize?: number;
};

export enum OpCode {
  HELLO = 100,
  STATE = 101,
  MOVE = 102,
  ERROR = 103,
  EVENT = 104,
  PING = 105
}
