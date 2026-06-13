# Dots & Boxes — Real-Time Multiplayer with Nakama

[![CI](https://github.com/KeyD0205/dots-boxes/actions/workflows/ci.yml/badge.svg)](https://github.com/KeyD0205/dots-boxes/actions/workflows/ci.yml)

A **server-authoritative** real-time multiplayer Dots and Boxes implementation. Every move is validated and applied on the server — clients are pure renderers. The server holds the single source of truth in memory and snapshots state to PostgreSQL after every accepted move, enabling transparent crash recovery without any client awareness.

**Stack:** [Nakama 3.22](https://heroiclabs.com/nakama/) · TypeScript · Vite · PostgreSQL 15 · Docker · GitHub Actions · Jest

---

## How to play

Players take turns drawing a line between two adjacent dots on a grid. When a player completes the fourth side of a 1×1 box, they claim it and earn a bonus turn. The player with the most boxes when the grid is full wins. A tie is possible.

---

## Features

- Create and join lobby rooms with a short six-character room code
- Real-time authoritative gameplay over WebSockets
- Configurable grid size (default 5×5 dots)
- Bonus turn on box completion
- Storage-backed snapshots after every accepted move
- Crash recovery: the first reconnecting client recreates the authoritative match from the persisted snapshot — transparent to all players
- Match history with winner, final scores, move count, duration, and full move log
- Graceful disconnect handling with reconnect semantics; seat is reserved by user ID
- Spectator mode via read-only room join

---

## Quick start

Requires Docker and Docker Compose.

```bash
git clone https://github.com/KeyD0205/dots-boxes.git
cd dots-boxes
cp .env.example .env
make up
```

| Service | URL |
|---------|-----|
| Game client | http://localhost:8080 |
| Nakama API | http://localhost:7350 |
| Nakama console | http://localhost:7351 |

Nakama console credentials: `admin@admin.com` / `password` (local dev only — see [Configuration](#configuration)).

### Local two-player demo

1. Open http://localhost:8080 and click **Connect**.
2. Click **Create Room** and copy the six-character room code.
3. Open a second tab, click **New Local Player**, then **Connect**.
4. Paste the room code and click **Join Room**.
5. Open a third tab and use **Spectate** to verify read-only live viewing.

**New Local Player** clears the `localStorage` device identity so a same-browser session can represent a second authenticated user.

---

## Developer commands

| Command | Description |
|---------|-------------|
| `make up` | Start all services using existing images |
| `make build` | Rebuild images without starting |
| `make down` | Stop containers, keep the database volume |
| `make clean` | Stop containers and **delete** the database volume |
| `make logs` | Stream logs from all services |
| `make test` | Run the Jest test suite |
| `make client-build` | Build the Vite client locally (`npm ci && vite build`) |
| `make nakama-build` | Build the Nakama runtime locally (`npm ci && rollup`) |

### Type checking (without building)

```bash
cd client && npx tsc --noEmit
cd nakama && npx tsc --noEmit
```

### Run a single test by name

```bash
cd nakama && npm test -- -t "applyMove"
```

---

## Configuration

Copy `.env.example` to `.env`. The defaults work for local development without any changes.

| Variable | Default | Purpose |
|----------|---------|---------|
| `POSTGRES_PASSWORD` | `localdb` | PostgreSQL password |
| `VITE_NAKAMA_HOST` | `localhost` | Nakama host the browser connects to |
| `VITE_NAKAMA_PORT` | `7350` | Nakama API port |
| `VITE_NAKAMA_SCHEME` | `http` | `http` or `https` |
| `NAKAMA_CLIENT_PUBLIC` | `defaultkey` | Nakama server key sent by the client |
| `NAKAMA_CONNECT_SRC` | `http://localhost:7350 ws://localhost:7350` | CSP `connect-src` origins baked into the Nginx image at build time. For HTTPS deployments set to `https://host:port wss://host:port` before running `make build`. |

Nakama admin credentials and server key live in `nakama/local.yml`. This file is volume-mounted at runtime and **never copied into the Docker image** so credentials do not enter any image layer.

---

## Architecture

```
Browser (Vite + Vanilla TypeScript)
  │
  ├─ HTTP RPC    create_room / join_room / get_room / list_history
  └─ WebSocket   OpCode 101 STATE · 102 MOVE · 103 ERROR · 104 EVENT
          │
Nakama runtime (TypeScript → CommonJS via Rollup)
  ├─ RPC handlers    room lifecycle, history, crash recovery
  ├─ Match handler   matchInit / matchJoin / matchLoop / matchLeave
  ├─ game.ts         pure game rules — edge validation, scoring, win detection
  └─ storage.ts      JSONB snapshots in PostgreSQL via Nakama storage API
          │
PostgreSQL 15
  ├─ room            live state snapshot, keyed by room code
  └─ match_history   completed games, keyed by roomCode:finishedAt
```

### State flow

1. Client authenticates with `authenticateDevice`.
2. Client calls an RPC to create or join a room.
3. RPC returns a room record and ensures a running authoritative match exists.
4. Client joins that match over the realtime socket.
5. Moves arrive as match state messages (OpCode 102).
6. Server validates the move against authoritative in-memory state.
7. Server updates state, writes a snapshot to storage, and broadcasts the new state (OpCode 101).
8. When the board is complete, the runtime writes a history record and broadcasts the result (OpCode 104).

### Consistency model

| Layer | Role |
|-------|------|
| In-memory Nakama match | Single-writer authority during play |
| PostgreSQL snapshot | Durability — written after every accepted move |
| `ensureRuntimeMatch` | Recovery — called by `join_room` and `get_room`; detects a dead match, reads the snapshot, and recreates the match process |

This yields **single-writer semantics** per match with crash recovery at the RPC boundary.

---

## Data model

All game data uses **Nakama storage collections** backed by PostgreSQL JSONB — no custom SQL tables or migrations needed.

### `room` collection

One object per joinable room, keyed by room code.

```json
{
  "roomCode": "ABCD12",
  "matchId": "<current authoritative match id>",
  "gridSize": 5,
  "status": "active",
  "createdAt": "2026-04-20T10:00:00.000Z",
  "updatedAt": "2026-04-20T10:00:05.000Z",
  "createdBy": "<user id>",
  "playerOrder": ["u1", "u2"],
  "snapshot": { "...current game state..." },
  "completedAt": null,
  "winnerIds": []
}
```

### `match_history` collection

Written when the game ends, keyed by `roomCode:finishedAt`.

```json
{
  "roomCode": "ABCD12",
  "gridSize": 5,
  "startedAt": "2026-04-20T10:00:02.000Z",
  "finishedAt": "2026-04-20T10:02:24.000Z",
  "durationSec": 142,
  "moves": 24,
  "scores": { "u1": 9, "u2": 7 },
  "winnerIds": ["u1"],
  "players": [
    { "userId": "u1", "username": "Ada" },
    { "userId": "u2", "username": "Linus" }
  ],
  "moveLog": ["..."]
}
```

---

## Testing

```bash
make test
```

70+ tests across three layers, with a **70% line/function coverage threshold** enforced in CI.

| File | What it covers |
|------|---------------|
| `nakama/tests/game.test.ts` | Pure game rules — edge validation, box completion, turn order, scoring, win/tie detection, regression cases for previously fixed deadlocks |
| `nakama/tests/storage.test.ts` | Storage layer — `buildRoomRecord`, `buildHistory`, `readRoom`, `writeRoom`, `writeHistory` with minimal typed `nkruntime` mocks |
| `nakama/tests/runtime.test.ts` | Pure helpers from `main.ts` — `randomRoomCode`, `json()`, `decodeMessageData()` including ArrayBuffer, Uint8Array, and legacy goja array-like paths |

Regression tests are named with the commit SHA of the bug they guard against.

---

## CI/CD

The GitHub Actions pipeline runs on every push and pull request.

```
app job
  ├─ tsc --noEmit (client)
  ├─ vite build
  ├─ tsc --noEmit (nakama)
  ├─ jest --coverage    ← fails if threshold not met
  └─ rollup build

containers job  (only runs when app passes)
  ├─ docker buildx build (GHA layer cache) — client image
  ├─ docker buildx build (GHA layer cache) — nakama image
  ├─ nginx -t from built client image
  └─ envsubst | nginx -t for edge nginx config
```

Container images are only built after all tests and type checks pass.

---

## Disconnection and reconnection

When a player disconnects:

- Their presence is removed from the active match.
- Their seat is reserved by user ID in the room snapshot.
- On reconnect, `matchJoinAttempt` allows the same user ID back into their prior slot and replays the latest state snapshot.

This implementation does not auto-forfeit by default. With more time, I would add a configurable inactivity timeout and auto-win policy.

---

## Scale considerations

### What scales well already

- Nakama authoritative matches are isolated and single-writer per room, mapping cleanly to many concurrent small rooms.
- Static assets are fully decoupled from the realtime backend.

### Likely bottlenecks at scale

1. **Snapshot write frequency** — every move writes to storage; an append-log-plus-checkpoint design would reduce write load.
2. **Hot rooms with many spectators** — increases broadcast fan-out per tick.
3. **Single-node match affinity** — each match must run on one Nakama node; horizontal scaling requires sticky routing.

### Next steps

- Multiple Nakama nodes behind a sticky load balancer.
- Move from "write every move" to event log with periodic checkpoints.
- CDN for static assets; route only API/WebSocket traffic to Nakama.
- OpenTelemetry counters: active rooms, move latency, reconnect success rate.

---

## Trade-offs

**Nakama storage over custom SQL:** Heroic Labs recommends the built-in storage engine for project data. Room lookup is naturally keyed by room code; snapshot is colocated with metadata, keeping recovery simple and cheap.

**Snapshot every move:** Simplifies restart recovery and keeps the implementation auditable. The cost is more write load versus an event-log design.

**Room-code lobby over matchmaking:** Simpler to implement and reason about while still demonstrating the full multiplayer lifecycle — create, join, play, history.

---

## What I would add with more time

- Explicit reconnect timeout with configurable auto-forfeit
- Replay UI built from `match_history.moveLog`
- OpenTelemetry metrics and Prometheus export
- Load-test scripts for thousands of concurrent sockets
- Party-based matchmaker flow instead of room-code only
- Optimistic client move animation with server reconciliation
- Admin match browser with indexed history search
