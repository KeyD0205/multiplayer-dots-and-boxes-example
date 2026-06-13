/// <reference path="../node_modules/nakama-runtime/index.d.ts" />

import { addPlayer, applyMove, canJoinAsPlayer, createInitialSnapshot, markDisconnected, normalizeGridSize, roomRoleForUser, startIfReady } from './game';
import { buildHistory, buildRoomRecord, readRoom, writeHistory, writeRoom } from './storage';
import { CreateRoomPayload, EnsuredMatch, EventPayload, JoinRoomPayload, MatchHistoryRecord, MatchState, OpCode, PlayerSeat, PresenceRef, SerializedState, StatePayload } from './types';

function randomRoomCode(): string {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var code = '';
  for (var i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function json<T>(payload: string): T {
  if (!payload) return {} as T;
  try {
    var parsed = JSON.parse(payload);
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    return parsed as T;
  } catch (_e) {
    return {} as T;
  }
}

function serialize(state: MatchState): SerializedState {
  return {
    roomCode: state.roomCode,
    gridSize: state.gridSize,
    status: state.status,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    currentTurnUserId: state.currentTurnUserId,
    players: state.players,
    spectators: state.spectators,
    edges: state.edges,
    boxes: state.boxes,
    scores: state.scores,
    moveLog: state.moveLog,
    winnerIds: state.winnerIds,
    reconnectGraceSec: state.reconnectGraceSec,
  };
}

function eventPayload<T>(type: string, data: T): EventPayload<T> {
  return {
    type: type,
    data: data,
  };
}

function statePayload(state: MatchState): StatePayload {
  return {
    matchId: state.matchId,
    snapshot: serialize(state),
  };
}

function hasConnectedPresenceForUser(state: MatchState, userId: string): boolean {
  for (var sessionId in state.presences) {
    if (state.presences[sessionId].userId === userId) {
      return true;
    }
  }

  return false;
}

function decodeMessageData(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }

  var out = '';
  var i = 0;

  // Nakama 3.22+ / goja 0.0.20+: message.data arrives as an ArrayBuffer.
  // ArrayBuffer has `byteLength`; wrap in Uint8Array to read individual bytes.
  if (data !== null && typeof data === 'object' && typeof (data as { byteLength?: unknown }).byteLength === 'number') {
    var bytes = new Uint8Array(data as ArrayBuffer);
    for (i = 0; i < bytes.length; i += 1) {
      out += String.fromCharCode(bytes[i]);
    }
    return out;
  }

  // Older goja versions delivered binary messages as plain array-like objects.
  if (data !== null && typeof data === 'object' && typeof (data as { length?: unknown }).length === 'number') {
    var arrayLike = data as ArrayLike<number>;
    for (i = 0; i < arrayLike.length; i += 1) {
      out += String.fromCharCode(arrayLike[i] & 0xff);
    }
    return out;
  }

  return String(data ?? '');
}

function ensureRuntimeMatch(nk: nkruntime.Nakama, logger: nkruntime.Logger, roomCode: string): EnsuredMatch {
  var room = readRoom(nk, logger, roomCode);
  logger.info('[ensureRuntimeMatch] Lookup for roomCode=%s, found=%s', roomCode, !!room);

  if (!room) {
    logger.warn('[ensureRuntimeMatch] Room not found for code=%s', roomCode);
    throw new Error('Room not found');
  }

  if (room.matchId) {
    try {
      var running = nk.matchGet(room.matchId);
      logger.info('[ensureRuntimeMatch] matchId=%s, match running=%s', room.matchId, !!running);
      if (running) {
        return { room: room, matchId: room.matchId };
      }
    } catch (_e) {
      // fall through to recovery
    }
  }

  if (room.snapshot) {
    var recreatedMatchId = nk.matchCreate('dots_boxes', {
      roomCode: roomCode,
      snapshot: room.snapshot,
    });

    var updated = Object.assign({}, room, {
      matchId: recreatedMatchId,
      updatedAt: new Date().toISOString(),
    });

    writeRoom(nk, logger, updated);
    logger.info('[ensureRuntimeMatch] Recovered room %s into new match %s', roomCode, recreatedMatchId);
    return { room: updated, matchId: recreatedMatchId };
  }

  logger.warn('[ensureRuntimeMatch] Room exists but has no snapshot for code=%s', roomCode);
  throw new Error('Room not recoverable');
}

function createRoomRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  var body = json<CreateRoomPayload>(payload);

  if (!ctx.userId) {
    throw new Error('Authentication required.');
  }

  var username = (body.username && body.username.trim()) || ctx.username || ('Player-' + ctx.userId.slice(0, 6));
  if (username.length > 24) {
    throw new Error('Username must be 24 characters or fewer.');
  }
  var gridSize = normalizeGridSize(body.gridSize);

  var roomCode = randomRoomCode();
  while (readRoom(nk, logger, roomCode)) {
    roomCode = randomRoomCode();
  }

  var snapshot = createInitialSnapshot(roomCode, gridSize, {
    userId: ctx.userId,
    username: username,
  });

  var matchId = nk.matchCreate('dots_boxes', {
    roomCode: roomCode,
    snapshot: snapshot,
  });

  var room = buildRoomRecord(snapshot, matchId, ctx.userId);
  writeRoom(nk, logger, room);

  logger.info('Created room %s match %s', roomCode, matchId);

  return JSON.stringify({
    roomCode: roomCode,
    matchId: matchId,
    snapshot: snapshot,
  });
}

function joinRoomRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  var body = json<JoinRoomPayload>(payload);

  if (!ctx.userId) {
    throw new Error('Authentication required.');
  }

  var roomCode = body.roomCode ? body.roomCode.trim().toUpperCase() : '';
  if (!roomCode) {
    throw new Error('roomCode is required.');
  }

  var ensured = ensureRuntimeMatch(nk, logger, roomCode);
  var room = ensured.room;
  var matchId = ensured.matchId;
  var username = (body.username && body.username.trim()) || ctx.username || ('Player-' + ctx.userId.slice(0, 6));
  if (username.length > 24) {
    throw new Error('Username must be 24 characters or fewer.');
  }

  var snapshot = room.snapshot as SerializedState;

  if (!body.spectator && snapshot.status !== 'finished') {
    if (!canJoinAsPlayer(snapshot, ctx.userId)) {
      throw new Error('Room already has two players. Join as a spectator.');
    }

    snapshot = addPlayer(snapshot, ctx.userId, username);
    snapshot = startIfReady(snapshot);
  }

  var role = roomRoleForUser(snapshot, ctx.userId);

  var updatedRoom = buildRoomRecord(snapshot, matchId, room.createdBy);
  writeRoom(nk, logger, updatedRoom);

  return JSON.stringify({
    roomCode: roomCode,
    matchId: matchId,
    snapshot: snapshot,
    role: role,
    spectator: role === 'spectator',
  });
}

function getRoomRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  if (!ctx.userId) {
    throw new Error('Authentication required.');
  }

  var body = json<{ roomCode: string }>(payload);
  var roomCode = body.roomCode ? body.roomCode.trim().toUpperCase() : '';

  if (!roomCode) {
    throw new Error('roomCode is required.');
  }

  var ensured = ensureRuntimeMatch(nk, logger, roomCode);

  return JSON.stringify({
    roomCode: roomCode,
    matchId: ensured.matchId,
    snapshot: ensured.room.snapshot,
  });
}

function listHistoryRpc(
  ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  _payload: string
): string {
  if (!ctx.userId) {
    throw new Error('Authentication required.');
  }
  var records = (nk as any).storageList('00000000-0000-0000-0000-000000000000', 'match_history', 50, '', '');
  var objects: Array<{ value: MatchHistoryRecord }> = (records && records.objects) ? records.objects : [];

  return JSON.stringify({
    items: objects.map(function (o) { return o.value; }),
  });
}

function matchInit(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  params: any
) {
  var snapshot = (params && params.snapshot) ? params.snapshot as SerializedState : null;
  if (!snapshot) {
    throw new Error('snapshot required');
  }

  logger.info('Initializing dots_boxes for room %s', snapshot.roomCode);

  return {
    state: {
      roomCode: snapshot.roomCode,
      gridSize: snapshot.gridSize,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      currentTurnUserId: snapshot.currentTurnUserId,
      players: snapshot.players,
      spectators: snapshot.spectators,
      edges: snapshot.edges,
      boxes: snapshot.boxes,
      scores: snapshot.scores,
      moveLog: snapshot.moveLog,
      winnerIds: snapshot.winnerIds,
      reconnectGraceSec: snapshot.reconnectGraceSec,
      presences: {},
      matchId: '',
    },
    tickRate: 5,
    label: 'roomCode=' + snapshot.roomCode,
  };
}

function matchJoinAttempt(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  _presence: nkruntime.Presence,
  _metadata: { [key: string]: any }
) {
  return { state: state, accept: true };
}

function matchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
) {
  state.matchId = state.matchId || ctx.matchId || '';

  var persistedRoom = readRoom(nk, logger, state.roomCode);
  if (persistedRoom && persistedRoom.snapshot) {
    var persistedMoveCount = (persistedRoom.snapshot.moveLog && persistedRoom.snapshot.moveLog.length) || 0;
    var liveMoveCount = (state.moveLog && state.moveLog.length) || 0;
    if (persistedMoveCount >= liveMoveCount) {
      Object.assign(state, persistedRoom.snapshot);
    } else {
      logger.info('Room %s: skipping storage overwrite on join (live=%d moves, stored=%d)', state.roomCode, liveMoveCount, persistedMoveCount);
    }
  }

  for (var p = 0; p < presences.length; p += 1) {
    var presence = presences[p];
    state.presences[presence.sessionId] = presence;

    var existingPlayer: PlayerSeat | null = null;
    for (var i = 0; i < state.players.length; i += 1) {
      if (state.players[i].userId === presence.userId) {
        existingPlayer = state.players[i];
        break;
      }
    }

    if (existingPlayer) {
      existingPlayer.isConnected = true;
      existingPlayer.username = presence.username || existingPlayer.username;

      if (state.status === 'active' && state.currentTurnUserId === null) {
        state.currentTurnUserId = existingPlayer.userId;
        logger.info('Room %s: repaired null turn to reconnecting player %s', state.roomCode, existingPlayer.userId);
      }
    } else {
      var spectatorSeat: PresenceRef = {
        userId: presence.userId,
        sessionId: presence.sessionId,
        username: presence.username,
        node: presence.node,
      };

      var filteredSpectators: PresenceRef[] = [];
      for (var s = 0; s < state.spectators.length; s += 1) {
        if (state.spectators[s].userId !== presence.userId) {
          filteredSpectators.push(state.spectators[s]);
        }
      }
      filteredSpectators.push(spectatorSeat);
      state.spectators = filteredSpectators;
    }
  }

  writeRoom(
    nk,
    logger,
    buildRoomRecord(
      serialize(state),
      state.matchId,
      state.players.length ? state.players[0].userId : ''
    )
  );

  dispatcher.broadcastMessage(
    OpCode.STATE,
    JSON.stringify(statePayload(state)),
    null,
    null,
    true
  );

  dispatcher.broadcastMessage(
    OpCode.EVENT,
    JSON.stringify(
      eventPayload('presence_joined', {
        userIds: presences.map(function (presence) { return presence.userId; }),
      })
    ),
    null,
    null,
    true
  );

  return { state: state };
}

function matchLeave(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
) {
  for (var p = 0; p < presences.length; p += 1) {
    var presence = presences[p];
    delete state.presences[presence.sessionId];

    if (!hasConnectedPresenceForUser(state, presence.userId)) {
      var updated = markDisconnected(serialize(state), presence.userId);
      Object.assign(state, updated);
    }
  }

  writeRoom(
    nk,
    logger,
    buildRoomRecord(
      serialize(state),
      state.matchId,
      state.players.length ? state.players[0].userId : ''
    )
  );

  dispatcher.broadcastMessage(
    OpCode.EVENT,
    JSON.stringify(
      eventPayload('presence_left', {
        userIds: presences.map(function (presence) { return presence.userId; }),
      })
    ),
    null,
    null,
    true
  );

  dispatcher.broadcastMessage(
    OpCode.STATE,
    JSON.stringify(statePayload(state)),
    null,
    null,
    true
  );

  return { state: state };
}

function matchLoop(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  messages: nkruntime.MatchMessage[]
) {
  for (var m = 0; m < messages.length; m += 1) {
    var message = messages[m];
    if (message.opCode !== OpCode.MOVE) {
      continue;
    }

    var payload: { edgeKey: string };

    try {
      var raw = decodeMessageData(message.data);
      if (!raw) {
        throw new Error('empty payload (dataType=' + typeof message.data + ')');
      }
      logger.info('Decoded move payload: %s', raw);
      payload = JSON.parse(raw);
      if (typeof payload.edgeKey !== 'string' || !payload.edgeKey) {
        throw new Error('edgeKey missing or invalid.');
      }
    } catch (err) {
      logger.warn('Move parse failed from %s: %s', message.sender.userId, String(err));
      dispatcher.broadcastMessage(
        OpCode.ERROR,
        JSON.stringify(eventPayload('invalid_payload', { reason: 'Malformed JSON.' })),
        [message.sender]
      );
      continue;
    }

    var result = applyMove(serialize(state), message.sender.userId, payload.edgeKey);

    if (result.error) {
      dispatcher.broadcastMessage(
        OpCode.ERROR,
        JSON.stringify(eventPayload('move_rejected', { reason: result.error })),
        [message.sender]
      );
      logger.warn('Move rejected: %s (user: %s, edge: %s)', result.error, message.sender.userId, payload.edgeKey);
      continue;
    }

    Object.assign(state, result.snapshot);

    logger.info('Room %s accepted move %s from %s', state.roomCode, payload.edgeKey, message.sender.userId);

    try {
      writeRoom(
        nk,
        logger,
        buildRoomRecord(
          serialize(state),
          state.matchId,
          state.players.length ? state.players[0].userId : ''
        )
      );
    } catch (writeErr) {
      logger.warn('Room %s: failed to persist state after move %s: %s', state.roomCode, payload.edgeKey, String(writeErr));
    }

    dispatcher.broadcastMessage(
      OpCode.STATE,
      JSON.stringify(statePayload(state)),
      null,
      null,
      true
    );

    dispatcher.broadcastMessage(
      OpCode.EVENT,
      JSON.stringify(
        eventPayload('move_accepted', {
          playerId: message.sender.userId,
          edgeKey: payload.edgeKey,
          completedBoxes: result.completedBoxes,
        })
      ),
      null,
      null,
      true
    );

    if (state.status === 'finished' && state.finishedAt) {
      writeHistory(nk, logger, buildHistory(serialize(state)));

      dispatcher.broadcastMessage(
        OpCode.EVENT,
        JSON.stringify(
          eventPayload('game_finished', {
            winnerIds: state.winnerIds,
            scores: state.scores,
          })
        ),
        null,
        null,
        true
      );

      logger.info('Room %s transitioned to FINISHED state.', state.roomCode);
    }
  }

  return { state: state };
}

function matchTerminate(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  _graceSeconds: number
) {
  writeRoom(
    nk,
    logger,
    buildRoomRecord(
      serialize(state),
      state.matchId,
      state.players.length ? state.players[0].userId : ''
    )
  );

  dispatcher.broadcastMessage(
    OpCode.EVENT,
    JSON.stringify(eventPayload('match_terminating', { roomCode: state.roomCode })),
    null,
    null,
    true
  );

  return { state: state };
}

function matchSignal(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  data: string
) {
  return { state: state, data: data };
}

function InitModule(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer
) {
  initializer.registerRpc('create_room', createRoomRpc);
  initializer.registerRpc('join_room', joinRoomRpc);
  initializer.registerRpc('get_room', getRoomRpc);
  initializer.registerRpc('list_history', listHistoryRpc);

  initializer.registerMatch('dots_boxes', {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });

  logger.info('Dots and Boxes runtime loaded.');
}

// Required Nakama InitModule registration pattern
!InitModule && InitModule.bind(null);
