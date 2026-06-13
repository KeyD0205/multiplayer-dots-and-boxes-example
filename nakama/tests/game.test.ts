import {
  addPlayer,
  applyMove,
  canJoinAsPlayer,
  createInitialSnapshot,
  edgeKey,
  startIfReady,
  totalPossibleEdges,
  normalizeGridSize,
  isAdjacentEdge,
  boxKey,
  boxesAffected,
  markDisconnected,
  roomRoleForUser,
  MAX_PLAYERS,
} from '../src/game';

describe('Dots and Boxes rules', () => {
  describe('utility functions', () => {
    test('normalizeGridSize clamps values', () => {
      expect(normalizeGridSize()).toBe(5);
      expect(normalizeGridSize(2)).toBe(3);
      expect(normalizeGridSize(10)).toBe(8);
      expect(normalizeGridSize(4)).toBe(4);
      expect(normalizeGridSize(7.9)).toBe(7);
    });

    test('isAdjacentEdge validates edge keys', () => {
      expect(isAdjacentEdge(3, '0,0-1,0')).toBe(true);
      expect(isAdjacentEdge(3, '0,0-0,1')).toBe(true);
      expect(isAdjacentEdge(3, '0,0-2,0')).toBe(false);
      expect(isAdjacentEdge(3, '0,0-0,3')).toBe(false);
      expect(isAdjacentEdge(3, '0,0-0,0')).toBe(false);
      expect(isAdjacentEdge(3, 'bad-key')).toBe(false);
    });

    test('boxKey returns correct string', () => {
      expect(boxKey(2, 3)).toBe('2,3');
    });

    test('boxesAffected returns correct boxes', () => {
      expect(boxesAffected(4, '1,2-1,3')).toEqual(['0,2', '1,2']);
      expect(boxesAffected(4, '2,1-3,1')).toEqual(['2,0', '2,1']);
      expect(boxesAffected(4, '0,0-0,1')).toEqual(['0,0']);
      expect(boxesAffected(4, '3,2-3,3')).toEqual(['2,2']);
    });

    test('markDisconnected sets player as disconnected and removes from spectators', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state.spectators.push({ userId: 'p2', username: 'Linus', sessionId: 'sess42' } as any);

      const updated = markDisconnected(state, 'p2');

      expect(updated.players.find((p) => p.userId === 'p2')?.isConnected).toBe(false);
      expect(updated.spectators.some((s) => s.userId === 'p2')).toBe(false);
    });

    test('addPlayer reconnects existing player and removes them from spectators', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = markDisconnected(state, 'p2');
      state.spectators.push({ userId: 'p2', username: 'OldName', sessionId: 'sess42' } as any);

      const updated = addPlayer(state, 'p2', 'Linus-New');

      expect(updated.players.find((p) => p.userId === 'p2')?.isConnected).toBe(true);
      expect(updated.players.find((p) => p.userId === 'p2')?.username).toBe('Linus-New');
      expect(updated.spectators.some((s) => s.userId === 'p2')).toBe(false);
    });

    test('player seats are capped at two while allowing reconnects', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');

      expect(canJoinAsPlayer(state, 'p2')).toBe(true);
      expect(canJoinAsPlayer(state, 'p3')).toBe(false);

      const updated = addPlayer(state, 'p3', 'Grace');

      expect(updated.players.map((p) => p.userId)).toEqual(['p1', 'p2']);
      expect(updated.scores.p3).toBeUndefined();
    });

    test('roomRoleForUser returns player only for seated users', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');

      expect(roomRoleForUser(state, 'p1')).toBe('player');
      expect(roomRoleForUser(state, 'p2')).toBe('player');
      expect(roomRoleForUser(state, 'spectator-1')).toBe('spectator');
    });

    test('roomRoleForUser keeps finished-room non-players as spectators', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = {
        ...startIfReady(state),
        status: 'finished',
        finishedAt: new Date().toISOString(),
      };

      expect(roomRoleForUser(state, 'p1')).toBe('player');
      expect(roomRoleForUser(state, 'late-user')).toBe('spectator');
    });
  });

  test('starts active when second player joins', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    expect(state.status).toBe('active');
    expect(state.currentTurnUserId).toBe('p1');
  });

  test('rejects move when game is not active', () => {
    const state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    const result = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));

    expect(result.error).toBe('Game is not active.');
  });

  test('rejects move when it is not the player turn', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const result = applyMove(state, 'p2', edgeKey(0, 0, 1, 0));
    expect(result.error).toBe('It is not your turn.');
  });

  test('rejects duplicate edges', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const move1 = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
    expect(move1.error).toBeUndefined();

    const move2 = applyMove(move1.snapshot, 'p2', edgeKey(0, 0, 1, 0));
    expect(move2.error).toBe('Edge already taken.');
  });

  test('rejects invalid edge', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const result = applyMove(state, 'p1', '0,0-2,0');
    expect(result.error).toBe('Invalid edge.');
  });

  test('completing a box grants an extra turn and score', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = applyMove(state, 'p1', edgeKey(0, 0, 1, 0)).snapshot;
    state = applyMove(state, 'p2', edgeKey(1, 0, 1, 1)).snapshot;
    state = applyMove(state, 'p1', edgeKey(0, 1, 1, 1)).snapshot;
    const result = applyMove(state, 'p2', edgeKey(0, 0, 0, 1));

    expect(result.error).toBeUndefined();
    expect(result.completedBoxes).toEqual(['0,0']);
    expect(result.snapshot.scores.p2).toBe(1);
    expect(result.snapshot.currentTurnUserId).toBe('p2');
  });

  test('one move can complete two boxes', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = {
      ...state,
      edges: {
        [edgeKey(0, 0, 1, 0)]: 'p1',
        [edgeKey(0, 0, 0, 1)]: 'p1',
        [edgeKey(0, 1, 0, 2)]: 'p1',
        [edgeKey(0, 2, 1, 2)]: 'p1',
        [edgeKey(1, 0, 2, 0)]: 'p1',
        [edgeKey(2, 0, 2, 1)]: 'p1',
        [edgeKey(2, 1, 2, 2)]: 'p1',
        [edgeKey(1, 2, 2, 2)]: 'p1',
        [edgeKey(1, 0, 1, 1)]: 'p1',
        [edgeKey(1, 1, 1, 2)]: 'p1',
      },
      currentTurnUserId: 'p2',
      status: 'active',
    };

    const result = applyMove(state, 'p2', edgeKey(0, 1, 1, 1));

    expect(result.error).toBeUndefined();
    expect(result.completedBoxes.sort()).toEqual(['0,0', '0,1']);
    expect(result.snapshot.scores.p2).toBe(2);
    expect(result.snapshot.currentTurnUserId).toBe('p2');
  });

  test('finishes game when all edges are drawn', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = {
      ...state,
      gridSize: 2,
      status: 'active',
      edges: {},
      boxes: {},
      scores: { p1: 0, p2: 0 },
      moveLog: [],
      currentTurnUserId: 'p1',
    };

    const edges = [
      edgeKey(0, 0, 1, 0),
      edgeKey(0, 0, 0, 1),
      edgeKey(0, 1, 1, 1),
      edgeKey(1, 0, 1, 1),
    ];

    let current = state;
    let player = 'p1';

    for (const key of edges) {
      const res = applyMove(current, player, key);
      current = res.snapshot;
      player = current.currentTurnUserId ?? 'p1';
    }

    expect(Object.keys(current.edges)).toHaveLength(totalPossibleEdges(2));
    expect(current.status).toBe('finished');
    expect(current.finishedAt).toBeTruthy();
    expect(current.winnerIds.length).toBeGreaterThan(0);
  });
});

// ─── Regression tests for fixed bugs ────────────────────────────────────────

describe('regression: null currentTurnUserId deadlock (fix c91f881)', () => {
  test('applyMove rejects any move when currentTurnUserId is null', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);
    state = { ...state, currentTurnUserId: null };

    const result = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
    expect(result.error).toBe('It is not your turn.');
  });

  test('marking all players disconnected yields null turn via nextTurn when no box is completed', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);
    state = markDisconnected(state, 'p1');
    state = markDisconnected(state, 'p2');

    // Empty board: placing one edge cannot complete any box, so nextTurn is called.
    // nextTurn finds no connected players → returns null → currentTurnUserId becomes null.
    const result = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
    expect(result.error).toBeUndefined();
    expect(result.snapshot.currentTurnUserId).toBeNull();
  });
});

describe('regression: randomRoomCode length (fix e1f8207)', () => {
  test('totalPossibleEdges is correct for all supported grid sizes', () => {
    expect(totalPossibleEdges(2)).toBe(4);
    expect(totalPossibleEdges(3)).toBe(12);
    expect(totalPossibleEdges(4)).toBe(24);
    expect(totalPossibleEdges(5)).toBe(40);
    expect(totalPossibleEdges(8)).toBe(112);
  });
});

// ─── Extended game logic coverage ────────────────────────────────────────────

describe('createInitialSnapshot', () => {
  test('produces a waiting game with the creator as first player and first turn holder', () => {
    const state = createInitialSnapshot('ABCD12', 4, { userId: 'u1', username: 'Creator' });

    expect(state.roomCode).toBe('ABCD12');
    expect(state.gridSize).toBe(4);
    expect(state.status).toBe('waiting');
    expect(state.players).toHaveLength(1);
    expect(state.players[0].userId).toBe('u1');
    expect(state.players[0].isConnected).toBe(true);
    expect(state.currentTurnUserId).toBe('u1');
    expect(state.scores.u1).toBe(0);
    expect(state.edges).toEqual({});
    expect(state.boxes).toEqual({});
    expect(state.winnerIds).toEqual([]);
    expect(state.startedAt).toBeNull();
    expect(state.finishedAt).toBeNull();
  });

  test('assigns the first COLORS entry to the creator', () => {
    const state = createInitialSnapshot('ROOM01', 3, { userId: 'u1', username: 'Ada' });
    expect(state.players[0].color).toBeTruthy();
    expect(state.players[0].color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('startIfReady', () => {
  test('is a no-op when game is already active', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);
    const snapshot = state.startedAt;

    const again = startIfReady(state);
    expect(again.status).toBe('active');
    expect(again.startedAt).toBe(snapshot);
  });

  test('is a no-op when only one player has joined', () => {
    const state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    const result = startIfReady(state);
    expect(result.status).toBe('waiting');
  });

  test('does not override an existing startedAt timestamp', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = { ...state, startedAt: '2024-01-01T00:00:00.000Z' };
    const result = startIfReady(state);
    expect(result.startedAt).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('isAdjacentEdge boundary cases', () => {
  test('accepts edges at the far grid boundary (gridSize - 1 coordinates)', () => {
    // gridSize=3: valid dot coordinates are 0, 1, 2
    expect(isAdjacentEdge(3, edgeKey(2, 1, 2, 2))).toBe(true);
    expect(isAdjacentEdge(3, edgeKey(1, 2, 2, 2))).toBe(true);
  });

  test('rejects an edge that steps outside the grid', () => {
    expect(isAdjacentEdge(3, edgeKey(2, 2, 3, 2))).toBe(false);
    expect(isAdjacentEdge(3, edgeKey(2, 2, 2, 3))).toBe(false);
  });

  test('rejects a zero-length edge (same point)', () => {
    expect(isAdjacentEdge(3, edgeKey(1, 1, 1, 1))).toBe(false);
  });
});

describe('addPlayer', () => {
  test('assigns distinct colors to each player', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    expect(state.players[0].color).not.toBe(state.players[1].color);
  });

  test('initialises new player score to 0', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    expect(state.scores.p2).toBe(0);
  });

  test('silent no-op when room is full and player is not a seat holder', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    const before = state.players.length;
    const result = addPlayer(state, 'p3', 'Grace');
    expect(result.players.length).toBe(before);
    expect(result.players.map((p) => p.userId)).not.toContain('p3');
  });

  test('MAX_PLAYERS constant is 2', () => {
    expect(MAX_PLAYERS).toBe(2);
  });
});

describe('applyMove: tie game', () => {
  test('declares single winner when one player has a higher final score', () => {
    // gridSize=2: 1 box, 4 edges. p2 places the last edge → completes the only box → wins 1-0.
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = {
      ...state,
      gridSize: 2,
      boxes: {},
      scores: { p1: 0, p2: 0 },
      edges: {
        [edgeKey(0, 0, 1, 0)]: 'p1',
        [edgeKey(1, 0, 1, 1)]: 'p1',
        [edgeKey(0, 1, 1, 1)]: 'p1',
      },
      currentTurnUserId: 'p2',
      moveLog: [],
    };

    const result = applyMove(state, 'p2', edgeKey(0, 0, 0, 1));

    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('finished');
    expect(result.snapshot.scores.p2).toBe(1);
    expect(result.snapshot.winnerIds).toEqual(['p2']);
    expect(result.snapshot.winnerIds).not.toContain('p1');
  });

  test('records a tie when both players have the same final score', () => {
    // 3x3 grid (4 boxes). Pre-fill 11 of 12 edges so that the last edge (2,1)-(2,2)
    // completes box '1,1' for p2, producing a final score of p1:2, p2:2.
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = {
      ...state,
      boxes:  { '0,0': 'p1', '1,0': 'p1', '0,1': 'p2' },
      scores: { p1: 2, p2: 1 },
      edges: {
        [edgeKey(0, 0, 1, 0)]: 'p1', [edgeKey(1, 0, 2, 0)]: 'p1',
        [edgeKey(0, 1, 1, 1)]: 'p1', [edgeKey(1, 1, 2, 1)]: 'p2',
        [edgeKey(0, 2, 1, 2)]: 'p1', [edgeKey(1, 2, 2, 2)]: 'p2',
        [edgeKey(0, 0, 0, 1)]: 'p1', [edgeKey(1, 0, 1, 1)]: 'p1',
        [edgeKey(2, 0, 2, 1)]: 'p1', [edgeKey(0, 1, 0, 2)]: 'p2',
        [edgeKey(1, 1, 1, 2)]: 'p2',
        // edgeKey(2, 1, 2, 2) is the only missing edge — completing box '1,1'
      },
      currentTurnUserId: 'p2',
      moveLog: [],
    };

    const result = applyMove(state, 'p2', edgeKey(2, 1, 2, 2));

    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('finished');
    expect(result.snapshot.scores.p1).toBe(2);
    expect(result.snapshot.scores.p2).toBe(2);
    expect(result.snapshot.winnerIds).toContain('p1');
    expect(result.snapshot.winnerIds).toContain('p2');
    expect(result.snapshot.winnerIds).toHaveLength(2);
  });
});

describe('applyMove: move log integrity', () => {
  test('each accepted move appends exactly one entry to moveLog', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const r1 = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
    expect(r1.snapshot.moveLog).toHaveLength(1);
    expect(r1.snapshot.moveLog[0].edgeKey).toBe(edgeKey(0, 0, 1, 0));
    expect(r1.snapshot.moveLog[0].playerId).toBe('p1');

    const r2 = applyMove(r1.snapshot, 'p2', edgeKey(1, 0, 2, 0));
    expect(r2.snapshot.moveLog).toHaveLength(2);
  });

  test('rejected move does not append to moveLog', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const result = applyMove(state, 'p2', edgeKey(0, 0, 1, 0));
    expect(result.error).toBeDefined();
    expect(result.snapshot.moveLog).toHaveLength(0);
  });
});
