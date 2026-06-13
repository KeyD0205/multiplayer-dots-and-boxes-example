/// <reference path="../node_modules/nakama-runtime/index.d.ts" />

import { buildRoomRecord, buildHistory, readRoom, writeRoom, writeHistory } from '../src/storage';
import { createInitialSnapshot, addPlayer, startIfReady } from '../src/game';
import { SerializedState } from '../src/types';

// ─── Minimal nakama mocks ────────────────────────────────────────────────────

function makeLogger(): nkruntime.Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as nkruntime.Logger;
}

function makeNk(storageRows: Array<{ value: unknown }> = []): nkruntime.Nakama {
  return {
    storageRead:  jest.fn().mockReturnValue(storageRows),
    storageWrite: jest.fn(),
  } as unknown as nkruntime.Nakama;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function twoPlayerSnapshot(): SerializedState {
  let s = createInitialSnapshot('ABCD12', 4, { userId: 'p1', username: 'Ada' });
  s = addPlayer(s, 'p2', 'Linus');
  return startIfReady(s);
}

// ─── buildRoomRecord ─────────────────────────────────────────────────────────

describe('buildRoomRecord', () => {
  test('copies top-level fields from snapshot', () => {
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-abc', 'p1');

    expect(rec.roomCode).toBe('ABCD12');
    expect(rec.gridSize).toBe(4);
    expect(rec.status).toBe('active');
    expect(rec.matchId).toBe('match-abc');
    expect(rec.createdBy).toBe('p1');
  });

  test('roomCode and snapshot.roomCode are uppercased', () => {
    let snap = createInitialSnapshot('abcd12', 3, { userId: 'p1', username: 'Ada' });
    const rec = buildRoomRecord(snap, 'match-1', 'p1');
    expect(rec.roomCode).toBe('ABCD12');
    expect(rec.snapshot.roomCode).toBe('ABCD12');
  });

  test('playerOrder reflects seat order', () => {
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-1', 'p1');
    expect(rec.playerOrder).toEqual(['p1', 'p2']);
  });

  test('snapshot inside the record is a deep clone — mutating the original does not affect it', () => {
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-1', 'p1');
    snap.players[0].username = 'MUTATED';
    expect(rec.snapshot.players[0].username).toBe('Ada');
  });

  test('winnerIds is an empty array for an active game', () => {
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-1', 'p1');
    expect(rec.winnerIds).toEqual([]);
  });

  test('completedAt is null for an active game', () => {
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-1', 'p1');
    expect(rec.completedAt).toBeNull();
  });
});

// ─── buildHistory ─────────────────────────────────────────────────────────────

describe('buildHistory', () => {
  test('computes durationSec from startedAt to finishedAt', () => {
    const snap = twoPlayerSnapshot();
    const finished: SerializedState = {
      ...snap,
      status: 'finished',
      startedAt:  '2024-06-01T10:00:00.000Z',
      finishedAt: '2024-06-01T10:01:30.000Z',
      winnerIds: ['p1'],
      scores: { p1: 3, p2: 1 },
    };

    const hist = buildHistory(finished);
    expect(hist.durationSec).toBe(90);
  });

  test('durationSec is 0 when startedAt is null', () => {
    const snap = twoPlayerSnapshot();
    const finished: SerializedState = {
      ...snap,
      status: 'finished',
      startedAt: null,
      finishedAt: '2024-06-01T10:01:30.000Z',
      winnerIds: ['p1'],
    };

    const hist = buildHistory(finished);
    expect(hist.durationSec).toBe(0);
  });

  test('falls back to current time when finishedAt is null', () => {
    const snap = twoPlayerSnapshot();
    const before = Date.now();
    const finished: SerializedState = {
      ...snap,
      status: 'finished',
      startedAt: null,
      finishedAt: null,
      winnerIds: ['p1'],
    };

    const hist = buildHistory(finished);
    const after = Date.now();
    const finishedMs = Date.parse(hist.finishedAt);
    expect(finishedMs).toBeGreaterThanOrEqual(before);
    expect(finishedMs).toBeLessThanOrEqual(after);
  });

  test('strips internal player fields down to userId, username, color', () => {
    const snap = twoPlayerSnapshot();
    const finished: SerializedState = { ...snap, status: 'finished', finishedAt: '2024-01-01T00:00:00.000Z', winnerIds: [] };
    const hist = buildHistory(finished);

    for (const p of hist.players) {
      expect(Object.keys(p).sort()).toEqual(['color', 'userId', 'username'].sort());
    }
  });

  test('moveLog entries are cloned — mutating source does not affect history', () => {
    let snap = twoPlayerSnapshot();
    snap = { ...snap, moveLog: [{ playerId: 'p1', edgeKey: '0,0-1,0', createdAt: '', completedBoxes: [], turnAfterMove: 'p2' }] };
    const finished: SerializedState = { ...snap, status: 'finished', finishedAt: '2024-01-01T00:00:00.000Z', winnerIds: ['p1'] };

    const hist = buildHistory(finished);
    snap.moveLog[0].edgeKey = 'MUTATED';
    expect(hist.moveLog[0].edgeKey).toBe('0,0-1,0');
  });
});

// ─── readRoom ─────────────────────────────────────────────────────────────────

describe('readRoom', () => {
  test('returns null when storage returns no rows', () => {
    const nk = makeNk([]);
    const result = readRoom(nk, makeLogger(), 'ABCD12');
    expect(result).toBeNull();
  });

  test('returns null and logs a warning when the stored value fails schema validation', () => {
    const logger = makeLogger();
    const nk = makeNk([{ value: { roomCode: 123, matchId: null } }]);
    const result = readRoom(nk, logger, 'ABCD12');
    expect(result).toBeNull();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });

  test('returns the RoomRecord when schema validation passes', () => {
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-xyz', 'p1');
    const nk = makeNk([{ value: rec }]);

    const result = readRoom(nk, makeLogger(), 'ABCD12');
    expect(result).not.toBeNull();
    expect(result!.roomCode).toBe('ABCD12');
    expect(result!.matchId).toBe('match-xyz');
  });

  test('passes the uppercased roomCode as the storage key', () => {
    const nk = makeNk([]);
    readRoom(nk, makeLogger(), 'abcd12');
    const call = (nk.storageRead as jest.Mock).mock.calls[0][0][0];
    expect(call.key).toBe('ABCD12');
  });

  test('returns null and does not throw when storageRead throws', () => {
    const nk = {
      storageRead: jest.fn().mockImplementation(() => { throw new Error('DB error'); }),
    } as unknown as nkruntime.Nakama;

    const result = readRoom(nk, makeLogger(), 'ABCD12');
    expect(result).toBeNull();
  });
});

// ─── writeRoom ────────────────────────────────────────────────────────────────

describe('writeRoom', () => {
  test('writes to the correct collection with system-user ownership', () => {
    const nk = makeNk();
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-1', 'p1');

    writeRoom(nk, makeLogger(), rec);

    const writeCall = (nk.storageWrite as jest.Mock).mock.calls[0][0][0];
    expect(writeCall.collection).toBe('room');
    expect(writeCall.userId).toBe('00000000-0000-0000-0000-000000000000');
    expect(writeCall.permissionRead).toBe(2);
    expect(writeCall.permissionWrite).toBe(0);
  });

  test('uses the uppercased roomCode as the storage key', () => {
    const nk = makeNk();
    const snap = createInitialSnapshot('lower1', 3, { userId: 'p1', username: 'Ada' });
    const rec = buildRoomRecord(snap, 'match-1', 'p1');

    writeRoom(nk, makeLogger(), rec);

    const writeCall = (nk.storageWrite as jest.Mock).mock.calls[0][0][0];
    expect(writeCall.key).toBe('LOWER1');
  });

  test('re-throws when storageWrite fails', () => {
    const nk = {
      storageWrite: jest.fn().mockImplementation(() => { throw new Error('write failed'); }),
    } as unknown as nkruntime.Nakama;
    const snap = twoPlayerSnapshot();
    const rec = buildRoomRecord(snap, 'match-1', 'p1');

    expect(() => writeRoom(nk, makeLogger(), rec)).toThrow('write failed');
  });
});

// ─── writeHistory ─────────────────────────────────────────────────────────────

describe('writeHistory', () => {
  test('uses roomCode:finishedAt as the storage key', () => {
    const nk = makeNk();
    const snap = twoPlayerSnapshot();
    const finished: SerializedState = {
      ...snap,
      status: 'finished',
      finishedAt: '2024-06-01T10:00:00.000Z',
      winnerIds: ['p1'],
    };
    const hist = buildHistory(finished);

    writeHistory(nk, makeLogger(), hist);

    const writeCall = (nk.storageWrite as jest.Mock).mock.calls[0][0][0];
    expect(writeCall.key).toBe('ABCD12:2024-06-01T10:00:00.000Z');
    expect(writeCall.collection).toBe('match_history');
  });
});
