# Dots and Boxes - Real-Time Multiplayer with Nakama

A server-authoritative multiplayer **Dots and Boxes** implementation built for browser clients with:

- **Nakama** for authentication, RPCs, match lifecycle, and WebSocket realtime play.
- **PostgreSQL** as the persistence layer backing Nakama storage and account/session data.
- **Vite + Vanilla TypeScript** web client.
- **Docker Compose** for one-command local startup.
- **Jest** tests for the core game rules.

## Features

- Create and join lobby rooms with a short room code.
- Real-time authoritative gameplay over WebSockets.
- Configurable grid size; default is 5x5 dots.
- Bonus turn when a player completes a box.
- Storage-backed snapshots after every move.
- Match recovery after server restart: the first reconnecting client can recreate the authoritative match from persisted snapshot data.
- Match history persisted at the end with winner, final scores, move count, duration, and full move log.
- Graceful disconnect handling with reconnect window semantics.
- Spectator mode via room join with read-only status.

---

## Running locally

### Requirements

- Docker
- Docker Compose

### Start

```bash
make up
```

Or:

```bash
docker compose up --build
```

### Open

- Client: http://localhost:8080
- Nakama API: http://localhost:7350
- Nakama Console: http://localhost:7351
  - email: `admin@admin.com`
  - password: `password`

> If the console credentials are needed in your environment, set them in the Nakama container entrypoint/config. This repo keeps the app itself focused on the game runtime and browser client.

### Local two-player demo

1. Open http://localhost:8080 and click **Connect**.
2. Click **Create Room** and copy the six-character room code.
3. Open a second tab or window, click **New Local Player**, then click **Connect**.
4. Paste the room code and click **Join Room**.
5. Use **Spectate** from another tab to verify read-only live viewing.

The browser client stores a local device identity in `localStorage`. **New Local Player** clears that identity so a same-browser demo can represent a second authenticated user.

### Stop

```bash
make down
```

---

## Development

### Building the Nakama runtime

The Nakama runtime is TypeScript-based and compiles to JavaScript.

```bash
cd nakama
npm install
npm run build
```

The build output goes to `nakama/build/index.js`, which is copied into the Docker image.

### Testing

Run the Jest tests locally:

```bash
cd nakama
npm test
```

Or from the root:

```bash
make test
```

Current automated coverage:

- Pure Dots and Boxes rules: move validation, turn order, scoring, box completion, win detection.
- Player seat behavior: two-player cap and reconnect-safe player seats.

Recommended showcase coverage to add next:

- RPC/match lifecycle tests with mocked Nakama APIs: create room, join room, spectator join, history listing.
- Browser or Playwright smoke test: connect, create room, join as a second local player, make one move.
- Docker smoke test: `docker compose up --build`, then verify the web client and Nakama API are reachable.

### Type checking

The project uses `nakama-runtime` type definitions from the GitHub package. If you encounter "Cannot find namespace 'nkruntime'" errors:

1. Ensure `moduleResolution` in `tsconfig.json` is set to `"node"` (not `"bundler"`)
2. Use triple-slash references in source files:
   ```typescript
   /// <reference path="../node_modules/nakama-runtime/index.d.ts" />
   ```

### Docker build

To build just the Nakama container:

```bash
docker compose build --no-cache nakama
```

---

## Repo layout

```text
.
├── client/               # Browser app
├── nakama/               # Authoritative game runtime and tests
├── docker-compose.yml
├── Makefile
└── README.md
```

---

## Architecture

### Components

```text
Browser Client
  ├─ REST auth / RPC via Nakama HTTP API
  └─ WebSocket realtime match stream
         │
         ▼
Nakama Runtime (authoritative match handler + RPCs)
  ├─ Holds live in-memory match state
  ├─ Validates all moves
  ├─ Broadcasts snapshots/events to clients
  └─ Persists room snapshots/history to storage
         │
         ▼
PostgreSQL
  ├─ Nakama accounts / sessions
  ├─ Nakama storage collections
  └─ Durable room and match history records
```

### State flow

1. Client authenticates with `authenticateDevice`.
2. Client calls an RPC to create or join a room.
3. RPC returns a room record, and ensures there is a running authoritative match.
4. Client joins that match over the realtime socket.
5. Moves are sent as match state messages.
6. Server validates the move against authoritative state.
7. Server updates in-memory state, writes a snapshot to storage, and broadcasts the new state.
8. When the board is complete, the runtime writes a completed history record.

### Consistency model

- **Authoritative truth during play**: the in-memory Nakama match handler.
- **Durable truth for recovery**: storage snapshot written after every accepted move.
- **Recovery after restart**: the next `join_room` or `get_room` call checks whether the referenced realtime match still exists. If not, Nakama creates a new authoritative match seeded from the persisted snapshot and updates the room record.

This yields **single-writer semantics** per match while still allowing crash recovery.

---

## Data model

This implementation uses **Nakama storage collections** backed by PostgreSQL rather than custom SQL tables. Heroic Labs recommends using the built-in storage engine instead of custom SQL for project data, and storage objects are persisted as JSONB in PostgreSQL.

### `room` collection

One object per joinable room.

```json
{
  "roomCode": "ABCD12",
  "matchId": "<current authoritative match id>",
  "gridSize": 5,
  "status": "waiting",
  "createdAt": "2026-04-20T10:00:00.000Z",
  "updatedAt": "2026-04-20T10:00:00.000Z",
  "createdBy": "<user id>",
  "playerOrder": ["u1", "u2"],
  "presenceByUserId": {},
  "snapshot": { ... current game state ... },
  "completedAt": null,
  "winnerIds": []
}
```

### `match_history` collection

Written when the game ends.

```json
{
  "roomCode": "ABCD12",
  "gridSize": 5,
  "startedAt": "...",
  "finishedAt": "...",
  "durationSec": 142,
  "moves": 24,
  "scores": {"u1": 9, "u2": 7},
  "winnerIds": ["u1"],
  "players": [
    {"userId": "u1", "username": "Ada"},
    {"userId": "u2", "username": "Linus"}
  ],
  "moveLog": [ ... ]
}
```

### Why this structure

- Room lookup is naturally keyed by room code.
- Snapshot is colocated with room metadata, which keeps recovery simple and cheap.
- Match history is immutable and append-only.
- Move log in history enables future replay and analytics.

---

## Database migrations

This project uses **Nakama's built-in storage engine** backed by PostgreSQL, which stores all game data as JSONB documents (room snapshots, match history). No custom schema migrations or raw SQL scripts are needed.

### Versioning your data model

If you extend the storage schema in the future:

1. **Add a version field** to your data structure:
   ```json
   {
     "version": 1,
     "roomCode": "ABCD12",
     ...
   }
   ```

2. **On read, check the version** and migrate old formats to new ones in application code:
   ```typescript
   const room = readRoom(nk, roomCode);
   if (!room.version) {
     // Migrate from v0 to v1
     room.version = 1;
     room.newField = getDefaultValue();
   }
   ```

3. **Never use raw SQL**; always use the Nakama storage API for consistency and multi-tenant safety.

---

## Disconnection and reconnection

When a player disconnects:

- Their presence is removed from the active match.
- Their seat remains reserved by user ID.
- The room snapshot still contains their identity and score.
- If they reconnect and rejoin the same room, `matchJoinAttempt` allows the same user ID back into their prior slot.

This implementation does **not** auto-forfeit by default. A room can continue when enough players remain connected, and disconnected users may return. With more time, I would add a configurable inactivity timeout and optional auto-win/forfeit policy.

---

## Scale plan for 10,000 concurrent players

### What scales well already

- Nakama authoritative matches are isolated and single-writer, which maps cleanly to many small rooms.
- Each match instance owns only one room’s state.
- Static assets are separate from the realtime backend.

### Likely bottlenecks

1. **Snapshot write frequency**: every move currently writes storage.
2. **Hot rooms**: spectators or very large rooms increase broadcast fan-out.
3. **Single-node affinity**: each match runs on one Nakama node.

### Next scaling steps

- Run multiple Nakama nodes behind a load balancer.
- Keep match affinity sticky per authoritative match.
- Move from “write every move” to “append move events + periodic checkpoints” if write load becomes dominant.
- Add a storage index or external analytics pipeline for large-scale history queries.
- Use Redis or message bus only if cross-service fan-out or analytics ingestion requires it.

Nakama’s authoritative match model keeps a given match on one node for consistency.

---

## CDN strategy

The browser bundle should be served via a CDN in production:

- Cache immutable build assets from `client/dist`.
- Route only API/WebSocket traffic to Nakama.
- Use a CDN or edge cache in front of static assets to reduce origin load and improve global latency.

Locally, the `web` container serves the built app with Nginx.

---

## Spectator mode and replay

### Live spectators

A spectator can join the room and then the match as a non-player. The current implementation supports read-only join mode in the UI and runtime.

### Historical replay

Replay can be built from `match_history.moveLog`:

1. Load a history record by room code or match key.
2. Start from an empty board.
3. Reapply moves sequentially at fixed or scrubbed intervals.

Because final history stores the full move log and player metadata, replay does not require the original match process to still exist.

---

## Observability

The runtime logs:

- room creation
- room recovery after restart
- player join/leave
- accepted moves
- game completion

With more time, I would export counters for active rooms, move latency, reconnect success rate, and average match duration.

---

## Testing

Run game rule tests:

```bash
make test
```

These tests cover:

- valid edge placement
- duplicate edge rejection
- box completion
- bonus turns
- game completion and winner calculation

The Jest approach for TypeScript runtime testing follows the official Heroic Labs guidance.

---

## Trade-offs

### Why Nakama storage instead of custom SQL tables?

Nakama’s storage engine is already backed by PostgreSQL and is designed for project data. Heroic Labs explicitly discourages custom SQL tables unless necessary.

### Why snapshot every move?

It simplifies restart recovery and keeps implementation understandable. The trade-off is more write load than an append-log-plus-checkpoint design.

### Why room-code based lobby?

It is simpler and more interview-friendly than ranking or queue-based matchmaking while still demonstrating the full multiplayer lifecycle.

---

## What I’d do differently with more time

- Add indexed storage search / admin match browser.
- Add explicit reconnect timeout and auto-forfeit option.
- Add replay UI and historical match page.
- Add OpenTelemetry and Prometheus metrics.
- Add load-test scripts for thousands of sockets.
- Add party-based matchmaker flow instead of room-code only.
- Add profile names and avatar colors persisted separately.
- Add optimistic client animation while still reconciling against server truth.

---

## Notes on the official docs used

- Nakama authoritative matches are registered and created via the TypeScript runtime.
- Nakama recommends Docker Compose for local installation.
- Nakama storage objects are JSON-backed and written through `storageWrite`.
