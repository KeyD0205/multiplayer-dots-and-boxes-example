import './style.css';
import { Client, Session, Socket } from '@heroiclabs/nakama-js';

type PlayerSeat = {
  userId: string;
  username: string;
  color: string;
  isConnected: boolean;
  joinedAt: string;
};

type Snapshot = {
  roomCode: string;
  gridSize: number;
  status: 'waiting' | 'active' | 'finished';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentTurnUserId: string | null;
  players: PlayerSeat[];
  spectators: Array<{ userId: string; username: string }>;
  edges: Record<string, string>;
  boxes: Record<string, string>;
  scores: Record<string, number>;
  moveLog: Array<{ playerId: string; edgeKey: string; completedBoxes: string[] }>;
  winnerIds: string[];
  reconnectGraceSec: number;
};

type HistoryEntry = {
  roomCode: string;
  gridSize: number;
  finishedAt: string;
  moves: number;
  durationSec: number;
  scores: Record<string, number>;
  winnerIds: string[];
  players: Array<{ userId: string; username: string; color: string }>;
};

type RoomRpcResult = {
  roomCode: string;
  matchId: string;
  snapshot: Snapshot;
  spectator?: boolean;
};

const OpCode = {
  STATE: 101,
  MOVE: 102,
  ERROR: 103,
  EVENT: 104,
};

const host = import.meta.env.VITE_NAKAMA_HOST || window.location.hostname;
const port = Number(import.meta.env.VITE_NAKAMA_PORT || '7350');
const useSSL = (import.meta.env.VITE_NAKAMA_SCHEME || 'http') === 'https';
const serverKey = import.meta.env.VITE_NAKAMA_SERVER_KEY || 'defaultkey';

const client = new Client(serverKey, host, port, useSSL, 3000);
client.ssl = useSSL;

const SESSION_KEY = 'nakamaSession';
const DEVICE_KEY = 'dots_boxes_device_id';
const ROOM_KEY = 'dots_boxes_room';
const SPECTATOR_KEY = 'dots_boxes_spectator';
const MAX_RECONNECT_ATTEMPTS = 5;

const state = {
  session: null as Session | null,
  socket: null as Socket | null,
  currentMatchId: null as string | null,
  snapshot: null as Snapshot | null,
  currentUserId: null as string | null,
  isSpectator: false,
  isConnecting: false,
  isConnected: false,
  reconnectAttempts: 0,
  reconnectInFlight: false,
  lastFinishedAtLogged: null as string | null,
};

const logLines: string[] = [];

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="app">
    <h1>Dots and Boxes</h1>

    <div class="panel">
      <div class="row">
        <input id="username" placeholder="Username" maxlength="24" />
        <select id="gridSize">
          <option value="4" selected>4x4 dots</option>
          <option value="5">5x5 dots</option>
          <option value="6">6x6 dots</option>
          <option value="7">7x7 dots</option>
        </select>
        <button id="connectBtn">Connect</button>
        <button id="resetIdentityBtn" class="secondary">New Local Player</button>
        <span id="authState" class="badge">Disconnected</span>
      </div>
    </div>

    <div class="panel">
      <div class="row">
        <button id="createBtn" disabled>Create Room</button>
        <input id="roomCode" placeholder="Room code" maxlength="6" />
        <button id="joinBtn" disabled>Join Room</button>
        <button id="spectateBtn" class="secondary" disabled>Spectate</button>
        <button id="refreshHistoryBtn" class="secondary" disabled>Refresh History</button>
      </div>
      <p class="small">For a same-browser demo, open a second tab and choose New Local Player before joining the room code.</p>
    </div>

    <div class="panel">
      <div id="roomSummary">No room joined yet.</div>
    </div>

    <div class="panel">
      <div class="scores" id="scores"></div>
    </div>

    <div class="panel grid-wrap">
      <div id="boardMount"></div>
    </div>

    <div class="panel">
      <h3>Event Log</h3>
      <div class="log" id="log"></div>
    </div>

    <div class="panel">
      <h3>Recent Match History</h3>
      <div id="history"></div>
    </div>
  </div>
`;

const usernameInput = document.querySelector<HTMLInputElement>('#username')!;
const gridSizeInput = document.querySelector<HTMLSelectElement>('#gridSize')!;
const connectBtn = document.querySelector<HTMLButtonElement>('#connectBtn')!;
const resetIdentityBtn = document.querySelector<HTMLButtonElement>('#resetIdentityBtn')!;
const createBtn = document.querySelector<HTMLButtonElement>('#createBtn')!;
const joinBtn = document.querySelector<HTMLButtonElement>('#joinBtn')!;
const spectateBtn = document.querySelector<HTMLButtonElement>('#spectateBtn')!;
const refreshHistoryBtn = document.querySelector<HTMLButtonElement>('#refreshHistoryBtn')!;
const roomCodeInput = document.querySelector<HTMLInputElement>('#roomCode')!;
const authState = document.querySelector<HTMLSpanElement>('#authState')!;
const roomSummary = document.querySelector<HTMLDivElement>('#roomSummary')!;
const scores = document.querySelector<HTMLDivElement>('#scores')!;
const boardMount = document.querySelector<HTMLDivElement>('#boardMount')!;
const logEl = document.querySelector<HTMLDivElement>('#log')!;
const historyEl = document.querySelector<HTMLDivElement>('#history')!;

function log(message: string) {
  logLines.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  logEl.textContent = logLines.slice(0, 60).join('\n');
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Response) return `HTTP ${err.status}: ${err.statusText}`;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as any).message);
  return String(err);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showErrorNotification(message: string) {
  const notification = document.createElement('div');
  notification.className = 'notification error';
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 4000);
}

function validateRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

function validateUsername(username: string): boolean {
  return username.length > 0 && username.length <= 24;
}

function addErrorHandler(fn: () => Promise<void>, label: string) {
  return () => {
    fn().catch((err) => {
      const msg = `${label} failed: ${extractErrorMessage(err)}`;
      log(msg);
      showErrorNotification(msg);
    });
  };
}

function saveSession(session: Session) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: session.token,
      refresh_token: session.refresh_token,
    })
  );
}

function loadSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.token) return null;

    const restored = Session.restore(parsed.token, parsed.refresh_token);
    if (!restored.isexpired(Date.now() / 1000)) {
      return restored;
    }
  } catch {
    // ignore
  }

  clearSession();
  return null;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function clearDeviceId() {
  localStorage.removeItem(DEVICE_KEY);
}

function saveRoomState(roomCode: string, spectator: boolean) {
  localStorage.setItem(ROOM_KEY, roomCode);
  localStorage.setItem(SPECTATOR_KEY, spectator ? '1' : '0');
}

function loadRoomState(): { roomCode: string; spectator: boolean } | null {
  const roomCode = localStorage.getItem(ROOM_KEY);
  if (!roomCode) return null;

  return {
    roomCode: roomCode,
    spectator: localStorage.getItem(SPECTATOR_KEY) === '1',
  };
}

function clearRoomState() {
  localStorage.removeItem(ROOM_KEY);
  localStorage.removeItem(SPECTATOR_KEY);
}

function getDeviceId(): string {
  let existing = localStorage.getItem(DEVICE_KEY);
  if (!existing) {
    existing = `${crypto.randomUUID()}-${Date.now()}`;
    localStorage.setItem(DEVICE_KEY, existing);
  }
  return existing;
}

function getUsername(): string {
  return usernameInput.value.trim() || `Player-${getDeviceId().slice(0, 6)}`;
}

function getCurrentRoomCode(): string | null {
  if (state.snapshot?.roomCode) return state.snapshot.roomCode;
  const room = loadRoomState();
  if (room?.roomCode) return room.roomCode;
  const raw = roomCodeInput.value.trim().toUpperCase();
  return raw || null;
}

function setConnectedUi(connected: boolean, username?: string) {
  createBtn.disabled = !connected;
  joinBtn.disabled = !connected;
  spectateBtn.disabled = !connected;
  refreshHistoryBtn.disabled = !connected;
  authState.textContent = connected ? `Connected as ${username ?? 'user'}` : 'Disconnected';
}

function resetGameState() {
  state.snapshot = null;
  state.currentMatchId = null;
  state.isSpectator = false;
  state.lastFinishedAtLogged = null;
}

function decodeMatchPayload(message: any): string {
  if (typeof message?.data === 'string') {
    return message.data;
  }

  if (message?.data instanceof Uint8Array) {
    return new TextDecoder().decode(message.data);
  }

  if (ArrayBuffer.isView(message?.data)) {
    const view = message.data;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }

  if (message?.data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(message.data));
  }

  if (typeof message?.state === 'string') {
    return message.state;
  }

  return '';
}

async function rpc<T>(id: string, body: unknown): Promise<T> {
  if (!state.session) throw new Error('Not authenticated');

  const result = await client.rpc(state.session, id, JSON.stringify(body));

  if (typeof result.payload === 'string') {
    return JSON.parse(result.payload) as T;
  }

  if (typeof result.payload === 'object' && result.payload !== null) {
    return result.payload as T;
  }

  throw new Error(`Invalid RPC response for ${id}`);
}

async function disconnect() {
  try {
    state.socket?.disconnect(true);
  } catch {
    // ignore
  }

  state.socket = null;
  state.session = null;
  state.currentUserId = null;
  state.isConnected = false;
  state.isConnecting = false;
  state.reconnectAttempts = 0;
  state.reconnectInFlight = false;
  resetGameState();
  clearSession();
  clearRoomState();
  setConnectedUi(false);
  render();
}

async function resetLocalIdentity() {
  await disconnect();
  clearDeviceId();
  usernameInput.value = '';
  roomCodeInput.value = '';
  log('Local player identity reset.');
}

function setupSocketHandlers() {
  if (!state.socket) return;

  state.socket.onmatchdata = (message: any) => {
    try {
      const opCode = message.op_code ?? message.opCode;
      const raw = decodeMatchPayload(message);

      if (opCode == null || !raw) {
        console.log('Invalid match message:', message, message?.data, message?.data?.constructor?.name);
        log('Invalid message format');
        return;
      }

      if (opCode === OpCode.STATE) {
        const parsed = JSON.parse(raw);
        state.snapshot = parsed.snapshot;
        state.currentMatchId = parsed.matchId;
        if (parsed.snapshot?.roomCode) {
          roomCodeInput.value = parsed.snapshot.roomCode;
          saveRoomState(parsed.snapshot.roomCode, state.isSpectator);
        }
        render();
        return;
      }

      if (opCode === OpCode.EVENT) {
        const event = JSON.parse(raw);
        log(`${event.type}: ${JSON.stringify(event.data)}`);
        return;
      }

      if (opCode === OpCode.ERROR) {
        const event = JSON.parse(raw);
        const msg = event.data?.reason || raw;
        log(`Error: ${msg}`);
        showErrorNotification(String(msg));
      }
    } catch (err) {
      console.error('Match message parse failure:', err, message);
      log(`Message parse error: ${extractErrorMessage(err)}`);
    }
  };

  state.socket.ondisconnect = () => {
    state.isConnected = false;
    log('Socket disconnected.');
    reconnectFlow().catch((err) => {
      log(`Reconnect flow failed: ${extractErrorMessage(err)}`);
    });
  };
}

async function ensureSocketConnected() {
  if (!state.session) throw new Error('No session');

  if (state.socket) {
    try {
      state.socket.disconnect(true);
    } catch {
      // ignore
    }
  }

  state.socket = client.createSocket(useSSL, false);
  setupSocketHandlers();
  await state.socket.connect(state.session, true);
  state.isConnected = true;
}

async function rejoinSavedRoom() {
  const restoredRoom = loadRoomState();
  if (!restoredRoom || !state.socket) return;

  const room = await rpc<RoomRpcResult>('get_room', { roomCode: restoredRoom.roomCode });
  state.currentMatchId = room.matchId;
  state.snapshot = room.snapshot;
  state.isSpectator = restoredRoom.spectator;
  roomCodeInput.value = room.roomCode;
  await state.socket.joinMatch(room.matchId);
  render();
  log(`Restored room ${room.roomCode}.`);
}

async function reconnectFlow() {
  if (state.reconnectInFlight) return;
  if (!state.session) return;

  state.reconnectInFlight = true;
  authState.textContent = 'Reconnecting...';

  while (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    state.reconnectAttempts += 1;

    try {
      await new Promise((r) => setTimeout(r, 1500));
      await ensureSocketConnected();
      await rejoinSavedRoom();

      state.reconnectAttempts = 0;
      state.reconnectInFlight = false;
      authState.textContent = `Connected as ${getUsername()}`;
      render();
      return;
    } catch (err) {
      log(`Reconnect attempt ${state.reconnectAttempts} failed: ${extractErrorMessage(err)}`);
    }
  }

  state.reconnectInFlight = false;
  authState.textContent = 'Reconnection failed';
  showErrorNotification('Connection lost. Please refresh and reconnect.');
}

async function connect() {
  if (state.isConnecting) return;
  state.isConnecting = true;

  try {
    const username = getUsername();
    if (!validateUsername(username)) {
      throw new Error('Invalid username');
    }

    let session = loadSession();
    if (!session) {
      session = await client.authenticateDevice(getDeviceId(), true, username);
      saveSession(session);
    }

    state.session = session;
    state.currentUserId = session.user_id;

    await ensureSocketConnected();

    state.reconnectAttempts = 0;
    state.isConnecting = false;
    setConnectedUi(true, username);
    log('Authenticated and socket connected.');

    if (!state.snapshot) {
      try {
        await rejoinSavedRoom();
      } catch (err) {
        log(`Room restore skipped: ${extractErrorMessage(err)}`);
      }
    }

    render();
  } catch (err) {
    state.isConnecting = false;
    throw err;
  }
}

async function createRoom() {
  if (!state.isConnected) {
    showErrorNotification('Not connected. Please connect first.');
    return;
  }

  const result = await rpc<RoomRpcResult>('create_room', {
    username: getUsername(),
    gridSize: Number(gridSizeInput.value),
  });

  roomCodeInput.value = result.roomCode;
  await joinRoomWithCode(result.roomCode, false);
}

async function joinRoomWithCode(roomCode: string, spectator: boolean) {
  if (!state.isConnected || !state.socket) {
    showErrorNotification('Not connected. Please connect first.');
    return;
  }

  const normalizedCode = roomCode.trim().toUpperCase();
  if (!validateRoomCode(normalizedCode)) {
    showErrorNotification('Invalid room code. Must be 6 alphanumeric characters.');
    return;
  }

  const result = await rpc<RoomRpcResult>('join_room', {
    roomCode: normalizedCode,
    username: getUsername(),
    spectator,
  });

  state.isSpectator = spectator;
  state.currentMatchId = result.matchId;
  state.snapshot = result.snapshot;
  roomCodeInput.value = result.roomCode;
  saveRoomState(result.roomCode, spectator);

  if (state.session) {
    state.currentUserId = state.session.user_id;
  }

  await state.socket.joinMatch(result.matchId);
  log(`${spectator ? 'Spectating' : 'Joined'} room ${result.roomCode}.`);
  render();
}

async function joinRoom(spectator: boolean) {
  await joinRoomWithCode(roomCodeInput.value, spectator);
}

async function refreshHistory() {
  const result = await rpc<{ items: HistoryEntry[] }>('list_history', {});
  const items = result.items || [];

  historyEl.textContent = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'small';
    empty.textContent = 'No completed matches yet.';
    historyEl.appendChild(empty);
    return;
  }

  for (const entry of items.slice().reverse()) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const summary = document.createElement('div');
    const room = document.createElement('strong');
    room.textContent = entry.roomCode;
    summary.appendChild(room);
    summary.append(` - ${entry.gridSize}x${entry.gridSize} dots - ${entry.moves} moves`);

    const details = document.createElement('div');
    details.className = 'small';
    details.textContent = `Finished ${new Date(entry.finishedAt).toLocaleString()} - Duration ${entry.durationSec}s`;

    const winners = document.createElement('div');
    winners.className = 'small';
    const winnerNames =
      entry.winnerIds.map((id) => entry.players.find((p) => p.userId === id)?.username || id).join(', ') || 'Draw';
    winners.textContent = `Winners: ${winnerNames}`;

    item.append(summary, details, winners);
    historyEl.appendChild(item);
  }

}

function edgeKey(aX: number, aY: number, bX: number, bY: number): string {
  const points = [[aX, aY], [bX, bY]].sort((lhs, rhs) =>
    lhs[0] === rhs[0] ? lhs[1] - rhs[1] : lhs[0] - rhs[0]
  );
  const p1 = points[0];
  const p2 = points[1];
  return `${p1[0]},${p1[1]}-${p2[0]},${p2[1]}`;
}

async function sendMove(key: string) {
  if (!state.socket || !state.currentMatchId || !state.snapshot || state.isSpectator) return;

  await state.socket.sendMatchState(
    state.currentMatchId,
    OpCode.MOVE,
    JSON.stringify({ edgeKey: key })
  );
}

function playerName(userId: string): string {
  return state.snapshot?.players.find((p) => p.userId === userId)?.username || userId;
}

function colorFor(userId?: string | null): string {
  return state.snapshot?.players.find((p) => p.userId === userId)?.color || '#64748b';
}

function handleBoardClick(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]');
  const key = btn?.dataset.edge;
  if (!key) return;

  sendMove(key).catch((err) => {
    const msg = extractErrorMessage(err);
    log(msg);
    showErrorNotification(msg);
  });
}

function renderBoard() {
  boardMount.removeEventListener('click', handleBoardClick);

  if (!state.snapshot) {
    boardMount.innerHTML = '<div class="small">Join a room to see the board.</div>';
    return;
  }

  const n = state.snapshot.gridSize - 1;
  const cells: string[] = [];

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const top = edgeKey(x, y, x + 1, y);
      const left = edgeKey(x, y, x, y + 1);
      const bottom = edgeKey(x, y + 1, x + 1, y + 1);
      const right = edgeKey(x + 1, y, x + 1, y + 1);
      const boxOwner = state.snapshot.boxes[`${x},${y}`];

      const parts = [
        ['t', top],
        ['l', left],
        ['b', bottom],
        ['r', right],
      ]
        .map(([cls, key]) => {
          const owner = state.snapshot!.edges[key];
          const style = owner ? `style="background:${colorFor(owner)}"` : '';
          const disabled =
            Boolean(owner) ||
            state.snapshot!.status !== 'active' ||
            state.snapshot!.currentTurnUserId !== state.currentUserId ||
            state.isSpectator;

          return `<button class="edge ${cls}" data-edge="${key}" ${style} ${disabled ? 'disabled' : ''}></button>`;
        })
        .join('');

      cells.push(`
        <div class="cell">
          ${parts}
          ${
            boxOwner
              ? `<div class="box" style="background:${colorFor(boxOwner)}">${escapeHtml(playerName(boxOwner).slice(0, 1).toUpperCase())}</div>`
              : ''
          }
          <span class="dot tl"></span><span class="dot tr"></span><span class="dot bl"></span><span class="dot br"></span>
        </div>
      `);
    }
  }

  boardMount.innerHTML = `<div class="board" style="grid-template-columns: repeat(${n}, 56px)">${cells.join('')}</div>`;
  boardMount.addEventListener('click', handleBoardClick);
}

function render() {
  if (!state.snapshot) {
    roomSummary.textContent = 'No room joined yet.';
    scores.innerHTML = '';
    renderBoard();
    return;
  }

  roomSummary.textContent = '';
  const summaryRow = document.createElement('div');
  summaryRow.className = 'row';

  for (const label of [
    `Room ${state.snapshot.roomCode}`,
    `Status: ${state.snapshot.status}`,
    state.isSpectator ? 'Spectator' : 'Player',
    `Turn: ${state.snapshot.currentTurnUserId ? playerName(state.snapshot.currentTurnUserId) : '-'}`,
  ]) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = label;
    summaryRow.appendChild(badge);
  }

  const connectionSummary = document.createElement('p');
  connectionSummary.className = 'small';
  connectionSummary.textContent = `Players connected: ${state.snapshot.players.filter((p) => p.isConnected).length}/${state.snapshot.players.length}. Spectators: ${state.snapshot.spectators.length}.`;
  roomSummary.append(summaryRow, connectionSummary);

  scores.textContent = '';
  for (const player of state.snapshot.players) {
    const card = document.createElement('div');
    card.className = 'score-card';

    const nameLine = document.createElement('div');
    const name = document.createElement('strong');
    name.style.color = player.color;
    name.textContent = player.username;
    nameLine.appendChild(name);

    const scoreLine = document.createElement('div');
    scoreLine.textContent = `Score: ${state.snapshot.scores[player.userId] ?? 0}`;

    const statusLine = document.createElement('div');
    statusLine.className = 'small';
    statusLine.textContent = player.isConnected ? 'Connected' : 'Disconnected';

    card.append(nameLine, scoreLine, statusLine);
    scores.appendChild(card);
  }

  if (
    state.snapshot.status === 'finished' &&
    state.snapshot.finishedAt &&
    state.lastFinishedAtLogged !== state.snapshot.finishedAt
  ) {
    const winners = state.snapshot.winnerIds.map((id) => playerName(id)).join(', ');
    log(`Game finished. Winner${state.snapshot.winnerIds.length > 1 ? 's' : ''}: ${winners}`);
    state.lastFinishedAtLogged = state.snapshot.finishedAt;
  }

  renderBoard();
}

connectBtn.addEventListener('click', addErrorHandler(connect, 'Connect'));
resetIdentityBtn.addEventListener('click', addErrorHandler(resetLocalIdentity, 'Reset identity'));
createBtn.addEventListener('click', addErrorHandler(createRoom, 'Create room'));
joinBtn.addEventListener('click', addErrorHandler(() => joinRoom(false), 'Join room'));
spectateBtn.addEventListener('click', addErrorHandler(() => joinRoom(true), 'Spectate'));
refreshHistoryBtn.addEventListener('click', addErrorHandler(refreshHistory, 'Refresh history'));

const restoredSession = loadSession();
if (restoredSession) {
  state.session = restoredSession;
  connect().catch((err) => {
    log(`Auto-connect failed: ${extractErrorMessage(err)}`);
    clearSession();
    clearRoomState();
    setConnectedUi(false);
  });
}

setConnectedUi(false);
render();
