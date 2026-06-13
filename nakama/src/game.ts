import { MatchMove, PlayerSeat, SerializedState } from './types';


/** Player colors for assignment. */
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

/** Standard Dots and Boxes room size. */
export const MAX_PLAYERS = 2;

/** Minimum allowed grid size. */
const MIN_GRID_SIZE = 3;
/** Maximum allowed grid size. */
const MAX_GRID_SIZE = 8;
/** Default grid size. */
const DEFAULT_GRID_SIZE = 5;
/** Default reconnect grace period in seconds. */
const DEFAULT_RECONNECT_GRACE_SEC = 60;


/**
 * Normalize the grid size to be within allowed bounds.
 */
export function normalizeGridSize(input?: number): number {
  const n = input ?? DEFAULT_GRID_SIZE;
  return Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, Math.floor(n)));
}


/**
 * Generate a unique key for an edge between two points.
 */
export function edgeKey(aX: number, aY: number, bX: number, bY: number): string {
  const [p1, p2] = [[aX, aY], [bX, bY]].sort((lhs, rhs) => {
    if (lhs[0] === rhs[0]) return lhs[1] - rhs[1];
    return lhs[0] - rhs[0];
  });
  return `${p1[0]},${p1[1]}-${p2[0]},${p2[1]}`;
}


/**
 * Check if the edge key represents a valid adjacent edge within the grid.
 */
export function isAdjacentEdge(gridSize: number, key: string): boolean {
  const [a, b] = key.split('-');
  if (!a || !b) return false;
  const [x1, y1] = a.split(',').map(Number);
  const [x2, y2] = b.split(',').map(Number);
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return false;
  if ([x1, y1, x2, y2].some((n) => n < 0 || n >= gridSize)) return false;
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return dx + dy === 1;
}


/**
 * Generate a unique key for a box at (x, y).
 */
export function boxKey(x: number, y: number): string {
  return `${x},${y}`;
}


/**
 * Get all edge keys for a box at (x, y).
 */
function boxEdges(x: number, y: number): string[] {
  return [
    edgeKey(x, y, x + 1, y),
    edgeKey(x, y, x, y + 1),
    edgeKey(x + 1, y, x + 1, y + 1),
    edgeKey(x, y + 1, x + 1, y + 1),
  ];
}


/**
 * Get the keys of boxes affected by an edge placement.
 */
export function boxesAffected(gridSize: number, key: string): string[] {
  const [a, b] = key.split('-');
  const [x1, y1] = a.split(',').map(Number);
  const [x2, y2] = b.split(',').map(Number);
  const result: string[] = [];
  if (x1 === x2) {
    const x = x1;
    const topY = Math.min(y1, y2);
    if (x > 0 && topY < gridSize - 1) result.push(boxKey(x - 1, topY));
    if (x < gridSize - 1 && topY < gridSize - 1) result.push(boxKey(x, topY));
  } else {
    const y = y1;
    const leftX = Math.min(x1, x2);
    if (y > 0 && leftX < gridSize - 1) result.push(boxKey(leftX, y - 1));
    if (y < gridSize - 1 && leftX < gridSize - 1) result.push(boxKey(leftX, y));
  }
  return result;
}


/**
 * Create the initial game state snapshot for a new room.
 */
export function createInitialSnapshot(roomCode: string, gridSize: number, creator: { userId: string; username: string }): SerializedState {
  const now = new Date().toISOString();
  const firstPlayer: PlayerSeat = {
    userId: creator.userId,
    username: creator.username,
    color: COLORS[0],
    isConnected: true,
    joinedAt: now,
  };

  return {
    roomCode,
    gridSize,
    status: 'waiting',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    currentTurnUserId: creator.userId,
    players: [firstPlayer],
    spectators: [],
    edges: {},
    boxes: {},
    scores: { [creator.userId]: 0 },
    moveLog: [],
    winnerIds: [],
    reconnectGraceSec: DEFAULT_RECONNECT_GRACE_SEC,
  };
}


/**
 * Check whether a user can occupy a player seat.
 */
export function canJoinAsPlayer(snapshot: SerializedState, userId: string): boolean {
  return snapshot.players.some((p) => p.userId === userId) || snapshot.players.length < MAX_PLAYERS;
}


/**
 * Add a player to the game snapshot, or reconnect if already present.
 * Also removes the user from spectators if they are joining as a player.
 */
export function addPlayer(snapshot: SerializedState, userId: string, username: string): SerializedState {
  if (snapshot.players.some((p) => p.userId === userId)) {
    return {
      ...snapshot,
      players: snapshot.players.map((p) => p.userId === userId ? { ...p, isConnected: true, username } : p),
      spectators: snapshot.spectators.filter((s) => s.userId !== userId),
    };
  }

  if (snapshot.players.length >= MAX_PLAYERS) {
    return snapshot;
  }

  const player: PlayerSeat = {
    userId,
    username,
    color: COLORS[snapshot.players.length % COLORS.length],
    isConnected: true,
    joinedAt: new Date().toISOString(),
  };

  return {
    ...snapshot,
    players: [...snapshot.players, player],
    spectators: snapshot.spectators.filter((s) => s.userId !== userId),
    scores: { ...snapshot.scores, [userId]: snapshot.scores[userId] ?? 0 },
    currentTurnUserId: snapshot.currentTurnUserId ?? userId,
  };
}


/**
 * Mark a player as disconnected in the snapshot.
 */
export function markDisconnected(snapshot: SerializedState, userId: string): SerializedState {
  return {
    ...snapshot,
    players: snapshot.players.map((p) => p.userId === userId ? { ...p, isConnected: false } : p),
    spectators: snapshot.spectators.filter((s) => s.userId !== userId),
  };
}


/**
 * Start the game if enough players are present and status is 'waiting'.
 */
export function startIfReady(snapshot: SerializedState): SerializedState {
  if (snapshot.status !== 'waiting') return snapshot;
  if (snapshot.players.length < 2) return snapshot;
  return {
    ...snapshot,
    status: 'active',
    startedAt: snapshot.startedAt ?? new Date().toISOString(),
    currentTurnUserId: snapshot.currentTurnUserId ?? snapshot.players[0]?.userId ?? null,
  };
}


/**
 * Calculate the total number of possible edges for a grid.
 */
export function totalPossibleEdges(gridSize: number): number {
  return (gridSize - 1) * gridSize * 2;
}


/**
 * Get the userId of the next connected player in turn order.
 * If no connected players remain, return null.
 */
function nextTurn(snapshot: SerializedState, currentUserId: string): string | null {
  const connectedPlayers = snapshot.players.filter((p) => p.isConnected);
  if (connectedPlayers.length === 0) return null;

  let idx = -1;
  for (let i = 0; i < connectedPlayers.length; i += 1) {
    if (connectedPlayers[i].userId === currentUserId) {
      idx = i;
      break;
    }
  }

  if (idx < 0) return connectedPlayers[0].userId;
  return connectedPlayers[(idx + 1) % connectedPlayers.length].userId;
}


/**
 * Apply a move to the game state, returning the updated snapshot and any completed boxes.
 */
export function applyMove(
  snapshot: SerializedState,
  playerId: string,
  key: string
): { snapshot: SerializedState; error?: string; completedBoxes: string[] } {
  if (snapshot.status !== 'active') return { snapshot, error: 'Game is not active.', completedBoxes: [] };
  if (snapshot.currentTurnUserId !== playerId) return { snapshot, error: 'It is not your turn.', completedBoxes: [] };
  if (!isAdjacentEdge(snapshot.gridSize, key)) return { snapshot, error: 'Invalid edge.', completedBoxes: [] };
  if (snapshot.edges[key]) return { snapshot, error: 'Edge already taken.', completedBoxes: [] };

  const newEdges = { ...snapshot.edges, [key]: playerId };
  const completedBoxes: string[] = [];
  const newBoxes = { ...snapshot.boxes };
  const newScores = { ...snapshot.scores };

  for (const candidate of boxesAffected(snapshot.gridSize, key)) {
    if (newBoxes[candidate]) continue;
    const [x, y] = candidate.split(',').map(Number);
    const complete = boxEdges(x, y).every((edge) => Boolean(newEdges[edge]));
    if (complete) {
      newBoxes[candidate] = playerId;
      newScores[playerId] = (newScores[playerId] ?? 0) + 1;
      completedBoxes.push(candidate);
    }
  }

  const turnAfterMove = completedBoxes.length > 0 ? playerId : nextTurn(snapshot, playerId);
  const move: MatchMove = {
    playerId,
    edgeKey: key,
    createdAt: new Date().toISOString(),
    completedBoxes,
    turnAfterMove,
  };

  let next: SerializedState = {
    ...snapshot,
    edges: newEdges,
    boxes: newBoxes,
    scores: newScores,
    currentTurnUserId: turnAfterMove,
    moveLog: [...snapshot.moveLog, move],
  };

  if (Object.keys(newEdges).length === totalPossibleEdges(snapshot.gridSize)) {
    let highest = -Infinity;
    for (const scoreKey in newScores) {
      if (newScores[scoreKey] > highest) highest = newScores[scoreKey];
    }
    const winnerIds: string[] = [];
    for (const userId in newScores) {
      if (newScores[userId] === highest) winnerIds.push(userId);
    }
    next = {
      ...next,
      status: 'finished',
      finishedAt: new Date().toISOString(),
      winnerIds,
      currentTurnUserId: null,
    };
  }

  return { snapshot: next, completedBoxes };
}
