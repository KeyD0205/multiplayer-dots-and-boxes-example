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
