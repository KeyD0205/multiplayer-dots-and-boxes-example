# Summary Report

## Approach

The dots-boxes implementation is a real-time multiplayer game built on Nakama 3.22, designed with a focus on consistency, crash recovery, and deterministic game logic. The central design choice is a **single-writer authority model during play**: the Nakama match handler holds in-memory state, and every accepted move is persisted to PostgreSQL.

This architecture keeps the game reliable during an interview because the consistency model is explicit:

```
Client WebSocket → Nakama match handler (match loop)
  ├─ Validate move against current state (game.ts)
  ├─ Apply move and update score
  ├─ Persist snapshot to PostgreSQL
  └─ Broadcast new state to all players
  
On crash recovery:
  ├─ Client attempts RPC (join_room or get_room)
  ├─ Server detects dead match, reads snapshot from storage
  ├─ Match process is recreated in-memory
  └─ Client rejoins and continues playing transparently
```

The implementation is deterministic in the core game rules. The same validation and scoring functions are used for move processing, state recovery, and test suites — this ensures game state cannot diverge between players.

---

## What was built

### Universal section

- **Match consistency model**: In-memory match process with durable storage snapshots after every accepted move.
- **Crash recovery**: Automatic detection and recreation of dead matches; clients rejoin transparently via `ensureRuntimeMatch()`.
- **Game rules engine** (`game.ts`): Pure deterministic functions for edge validation, box completion, and score calculation.
  - Prevents invalid moves (edge already claimed, out of bounds, invalid edge format).
  - Correctly identifies completed boxes and awards points to the player who completed them.
  - Handles box-completion chains (when one player completes multiple boxes in sequence).
- **Storage layer** (`storage.ts`): Abstracts room snapshots and match history persistence.
  - Uses Nakama's JSONB storage with system-user ownership and public read access.
  - Implements schema versioning via a `version` field for safe evolution.
  - No raw SQL; all data access through Nakama's storage API.
- **Type safety**: Shared TypeScript types (`types.ts`) for `SerializedState`, `RoomRecord`, and `MatchHistoryRecord` ensure client and server agree on data shapes.
- **WebSocket protocol**: Four OpCodes for real-time communication:
  - **101**: STATE snapshot (full board, moves, scores, turn order)
  - **102**: MOVE request (player submits edge claim)
  - **103**: ERROR (move validation failure)
  - **104**: EVENT (presence_joined, move_accepted, game_finished, etc.)
- **Test suite**: 
  - Game rules validation (edge cases, box scoring, multi-box chains).
  - Storage round-trip tests (serialize/deserialize state).
  - Runtime match lifecycle tests (init, join, move, leave, termination).

### Backend (Nakama)

- **Match handler** (`main.ts`): Implements `matchInit`, `matchJoin`, `matchLoop`, `matchLeave`, `matchTerminate`.
- **RPC endpoints**:
  - `create_room` — Creates a new game, returns room code and initial state.
  - `join_room` — Joins an existing game, triggers crash recovery if the match is stale.
  - `get_room` — Fetches the current state of an active game (polling fallback).
  - `list_history` — Returns list of completed games with final scores.
- **Match loop** — Processes move opcodes, validates edges, updates state, persists snapshots, broadcasts to all players.
- **Message handling** — Handles both modern ArrayBuffer payloads and legacy string/array formats for robustness.
- **Docker deployment** — Runs in a container with PostgreSQL backend.

### Frontend (Vite + Vanilla TypeScript)

- **Board UI** (`client/src/main.ts`): Renders a 6×6 grid of dots and edges.
  - Draws horizontal and vertical edges; clicked edges are claimed by the current player.
  - Displays box fill and ownership when all four edges are claimed.
  - Shows player turn indicator, scores, and room code.
- **Multiplayer state sync**: Subscribes to match stream (OpCode 101, 104) and updates the board in real-time.
- **Error handling**: Displays validation errors when invalid moves are attempted.
- **Vite dev server** — Fast HMR development on `http://localhost:5173`.

---

## Key game mechanics

| Mechanic | Behavior |
|----------|----------|
| Board size | 6×6 dots (5×5 boxes) |
| Turn order | Players alternate; first move goes to the player who created the room |
| Box completion | Player scores 1 point for every box they complete; if multiple boxes complete in one move, they score all of them and take another turn |
| Game end | Game ends when all 25 boxes are claimed; highest score wins |
| Crash recovery | If server restarts, matches are recreated from storage on next client RPC; no game state is lost |
| State snapshot | After every accepted move, the full game state is written to PostgreSQL |

---

## Data structure and persistence

### Room (Live match)
```typescript
{
  roomCode: string              // Unique identifier, e.g., "ABCD1234"
  players: { userId, name }[]   // Array of player objects
  state: SerializedState        // Current board, moves, scores, turn
  createdAt: timestamp
  updatedAt: timestamp
}
```

### Match history (Completed game)
```typescript
{
  roomCode: string
  finishedAt: timestamp
  finalState: SerializedState   // Board with all moves, final scores
  winner: { userId, name, score }
}
```

All records are stored in PostgreSQL via Nakama's storage API with JSONB columns, owned by the system user, readable by all.

---

## System design perspective

### Design principles

- **Single-writer authority**: Only the match handler updates live state; clients send moves, not state.
- **Durability first**: Every accepted move triggers a storage write; no move is lost.
- **Deterministic game logic**: Game rules (`game.ts`) are pure functions; they can be tested in isolation, replayed for recovery, or used to validate client-side predictions.
- **Transparent crash recovery**: Clients don't know or care whether the match process restarted; they rejoin seamlessly.
- **Type safety**: TypeScript and strict tsconfig on both client and server catch schema mismatches early.
- **Storage versioning**: The `version` field in state JSON allows schema evolution without migrations.

### Reference production architecture

For a production system, I would evolve this into:

```
Client WebSocket (current)
  ├─ Match consistency (current)
  └─ Single room, immediate crash recovery (current)

Production:
  ├─ Load balancer → multiple Nakama instances
  ├─ Shared session store (Redis) for match location
  ├─ Durable event log (Kafka/Pulsar) for audit and replay
  ├─ PostgreSQL → read replicas for history queries
  ├─ Materialized match index for fast room lookups
  └─ Metrics: move latency, error rates, crash-recovery success rate
```

### Handling larger scale

- **Match sharding**: Partition matches by `roomCode` across multiple Nakama instances; use Redis to track which instance owns which match.
- **Player limit**: The current design supports 2–6 players per room. For larger tournaments, add a `spectator` role that receives updates but cannot move.
- **Historical queries**: Instead of scanning the match history on each `list_history` RPC, materialize recent games in a separate table indexed by `userId`.
- **Replay and audit**: An event log would let you replay any completed game move-by-move, useful for dispute resolution or anti-cheat verification.

---

## Security and operational considerations

### Current state

- **Storage permissions**: All game records are readable by all players (public) but writable only by the system (no player can mutate).
- **Message validation**: Move messages are validated server-side; a player cannot claim an already-claimed edge or move out of turn.
- **Cheating resistance**: The server is authoritative; clients cannot force invalid moves.

### Production recommendations

- **Rate limiting**: Add per-player move rate limits to prevent input spam.
- **Latency fairness**: Track move-submission timestamps and reject moves that arrive after game-end.
- **Audit log**: Log all moves with timestamps and player IDs for post-game verification.
- **Player identity**: Integrate with a persistent authentication system so players can resume games across sessions.

---

## Frontend considerations

### Operator vs. player feedback

- **Real-time players**: Need immediate visual feedback that their move was accepted (edge highlight + opponent's board update in < 200ms).
- **Spectators**: Can tolerate slightly stale state (polling every 2–5 seconds via `get_room` RPC).
- **Mobile players**: May have spotty connectivity; should display a reconnect banner if the WebSocket drops and queue moves offline.

### UI improvements for scale

- **Room lobby**: Currently missing; add a room browser so players can find and join active games.
- **Player profiles**: Display win/loss record, elo rating, or seasonal rank.
- **Game replay**: Save and replay completed games move-by-move for analysis or dispute resolution.
- **Mobile responsiveness**: Current board is desktop-only; responsive design would open mobile and tablet platforms.

---

## What works well

1. **Game state consistency**: The match process is the single source of truth; no state divergence between players.
2. **Crash safety**: Every move is persisted before broadcast; loss of a Nakama process does not lose game state.
3. **Deterministic rules**: Pure functions in `game.ts` are testable, replayable, and auditable.
4. **Real-time responsiveness**: WebSocket OpCode 101/104 messages arrive in < 100ms in a local environment.
5. **Type safety**: Shared TypeScript types catch contract mismatches at build time.

---

## Tradeoffs and known limitations

| Tradeoff | Rationale |
|----------|-----------|
| Single Nakama instance | Sufficient for development and small-scale play; production would require load-balancing across multiple instances |
| No player persistence | Games are transient; players must rejoin by room code after a page refresh. Production would link to a user ID |
| No move history UI | Completed games are stored but not easily browsable; a replay feature would be valuable for players and anti-cheat review |
| ArrayBuffer message format | Nakama 3.22+ sends messages as ArrayBuffer, not strings; the decoder handles both for backwards compatibility |
| Synchronous state updates | Clients see moves only after the server broadcasts them; local prediction is not implemented, so perceived latency is one round-trip |

---

## Recommendations for further development

1. **Persistent player accounts**: Link games to user IDs so players can resume and build a win/loss history.
2. **Room browsing and matchmaking**: Add a lobby UI where players can list open rooms or be matched based on rating.
3. **Game replay UI**: Store all moves and allow players to step through a completed game move-by-move.
4. **Mobile support**: Responsive design and optimized touch controls for phones and tablets.
5. **Elo/rating system**: Track player skill over time and seed matchmaking.
6. **Spectator mode**: Allow other players to watch an in-progress game without affecting the outcome.
7. **Timed turns**: Add a clock so moves must be submitted within a time limit (e.g., 60 seconds per turn).
8. **Event log for audit**: Durable logging of all moves for anti-cheat and replay verification.
9. **Rate limiting and security**: Enforce per-player rate limits and validate that moves respect turn order and timing constraints.
10. **Dashboard**: Admin view of active games, player metrics, and server health.

---

## Local development and testing

### Quick start
```bash
make up          # Start PostgreSQL, Nakama, and web client
make logs        # Stream logs
make test        # Run Jest test suite (Nakama game rules)
make client-build    # Bundle the frontend for production
```

### Services
- **Web client**: `http://localhost:8080`
- **Nakama API**: `http://localhost:7350`
- **Nakama console**: `http://localhost:7351` (admin@admin.com / password)

### Test coverage
- Game rules validation (edge cases, box scoring, multi-box chains)
- Storage round-trip (serialize/deserialize)
- Runtime match lifecycle

---

## Additional Links
- [Repository](https://github.com/KeyD0205/dots-boxes)
- [CLAUDE.md](CLAUDE.md) — Engineering standards and architecture notes
- [Game rules](nakama/src/game.ts)
- [Storage layer](nakama/src/storage.ts)
- [Client UI](client/src/main.ts)
