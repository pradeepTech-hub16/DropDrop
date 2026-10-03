# DropDrop

**Drop it. Share it. Sync it.**

A login-free, room-based shared text workspace. Enter a room name and everyone who opens the same room edits the
same document in real time. Content is stored in MongoDB Atlas and survives refreshes, reconnects and server restarts.

> **Status: Phase 4 of 6.** Real-time collaboration (Yjs over WebSockets) works on the website **and** in the new
> VS Code extension, which share the same backend, rooms and database. Deployment is *prepared* (Vercel for the
> website, a persistent host for the backend) but nothing has been deployed or published. See
> [DEPLOYMENT.md](DEPLOYMENT.md).

## Quick links

* [DEPLOYMENT.md](DEPLOYMENT.md): production architecture, Vercel decision, environment variables, Marketplace steps
* [vscode-extension/README.md](vscode-extension/README.md): the extension (commands, settings, privacy note)

## Monorepo layout

| Folder | Purpose | Status |
| --- | --- | --- |
| `frontend/` | React + Vite + Tailwind + CodeMirror 6 website (Vercel-ready) | Phases 1–4 done |
| `backend/` | Express REST API + WebSocket/Yjs server + MongoDB Atlas | Phases 2–4 done |
| `vscode-extension/` | TypeScript VS Code extension (webview editor, Yjs) | Phase 4 done |
| `e2e/` | Cross-platform tests: website ↔ VS Code ↔ VS Code, and production-build checks | Phase 4 |

## Architecture

```
Browser A ─┐
Browser B ─┼── WebSocket  ws://host/ws/<roomName>  ──▶  Yjs doc per room  ──▶  MongoDB Atlas
Browser C ─┘      (y-websocket protocol)               (CollabManager)         (Room + RoomUpdate)
Website / REST clients ── HTTP /api/rooms/... ─────────▶ same live documents
```

* **One Yjs document per room**, keyed by the room name (validated with the same rules as the frontend).
  It holds a `Y.Text "content"` and a `Y.Map "meta"` (currently just `language`).
* **Yjs is a CRDT**, so simultaneous edits merge deterministically on every client and on the server. There is no
  last-write-wins on the collaborative path.
* **The server** (`backend/src/collab/`) speaks the standard `y-websocket` sync + awareness protocol, so stock
  `y-websocket` clients work unchanged. It validates messages, enforces limits, relays updates to the room's other
  clients, and persists the document.
* **The website** binds CodeMirror 6 to the shared `Y.Text` with `y-codemirror.next` (Yjs-aware undo/redo, remote
  cursors and selections) and connects with `y-websocket`'s `WebsocketProvider`.

### WebSocket protocol (for Phase 4 / other clients)

* URL: `ws://localhost:5000/ws/<roomName>`; plain `y-websocket` clients work out of the box:
  `new WebsocketProvider('ws://localhost:5000/ws', roomName, ydoc)`.
* Messages: `0` sync, `1` awareness, `3` query-awareness (standard). Binary frames only; max 2 MB per message.
* Optional extension: connect with `?persisted-ack=1` to receive message type `10` after each durable write; its
  payload is the Yjs **state vector that is stored in MongoDB**. A client that compares it to its own state vector
  knows whether its edits are saved. The website uses this for its "Saving… / ✓ Saved" indicator. It is opt-in so
  stock clients never see an unknown message type.
* Close codes: **4400** invalid room name, **4401** malformed message, **4403** origin not allowed, **4413** message or
  document too large, **4429** rate limited. These are permanent: `y-websocket` clients stop reconnecting.
  **1013** (busy / DB unavailable / room full) and **1001** (server restarting) are transient: clients retry.
* Browsers must send an allowed `Origin` (`ALLOWED_ORIGINS`). Clients that send no `Origin` (VS Code, Node, CLI) are allowed.

### Persistence strategy (MongoDB Atlas)

| Collection | Content |
| --- | --- |
| `rooms` (`Room`) | `yjsState`: snapshot (`Y.encodeStateAsUpdate`). `content`/`language`: plain-text mirror for the REST API. |
| `roomupdates` (`RoomUpdate`) | Append-only log of **batched** Yjs updates since the last snapshot. |

* **Load** = snapshot + every logged update. Yjs updates commute and are idempotent, so order and duplicates don't matter.
* **Writes are batched**: at most one log insert (+ one mirror update) per room per second, however many keystrokes
  occurred (measured: 1,000 edits from 10 clients → 1 write). Nothing is saved "per keystroke".
* **Compaction**: after 100 batches, on last-client-leaves, and on shutdown, the whole doc is written as a snapshot
  and the covered log entries are deleted (snapshot first, then delete, so a crash can't lose data).
* **Durability**: edits are saved immediately when the last person leaves a room and on a clean shutdown. A hard crash loses edits only if the server dies between two writes (default every 1 s, configurable with `COLLAB_FLUSH_INTERVAL_MS`) **and** every client holding the unsaved edit disappears before the server is back; a client that stays open re-sends its edits when the server returns. Everything already written stays intact. `SIGINT`/`SIGTERM` flush everything first.
* **Idle rooms** are freed from memory 30 s after the last client leaves.
* A failed write keeps the updates in memory and retries; connected clients are never told "saved" until it succeeds.
* **Single server instance assumed.** Running several backend instances against one database would need a shared
  pub/sub layer (see limitations).

### REST ↔ real-time

`PUT /api/rooms/:name` no longer overwrites anything. It is applied to the live Yjs document as a **minimal diff**
(common prefix/suffix), so it merges with concurrent edits and is broadcast to connected clients. `GET` flushes the
live document first, so it always returns current content.

### Migration from Phase 2

No manual step and nothing destructive. A room with plain `content` and no Yjs state is initialised into Yjs the first
time anyone connects, and a snapshot is written immediately. The old `content`/`language` fields stay (as a mirror) and
all Phase 2 data is untouched. Verified against Atlas with a Phase 2-style room.

## Setup

Requires Node.js 20+.

### 1. MongoDB Atlas

1. In Atlas, create a **database user** (Database Access) and allow your IP (Network Access).
2. Take the connection string from **Connect → Drivers** and add the database name `dropdrop` before the `?`:
   `mongodb+srv://<user>:<db_password>@<cluster-host>/dropdrop?appName=Cluster0`
   (URL-encode special characters in the password).

### 2. Environment

```powershell
cd backend
Copy-Item .env.example .env      # skip if it already exists; then edit MONGODB_URI
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | HTTP + WebSocket port | `5000` |
| `MONGODB_URI` | Atlas connection string incl. `/dropdrop` | *(required)* |
| `ALLOWED_ORIGINS` | Trusted website origin(s) for CORS **and** WebSocket, comma-separated (`CLIENT_URL` is the legacy alias; `ALLOWED_ORIGINS` wins if both are set) | `http://localhost:5173` |
| `NODE_ENV` | `development` / `production` | `development` |
| `COLLAB_FLUSH_INTERVAL_MS` | How often an active room is written to MongoDB (250-10000 ms). Default 1000; see "Durability" and DEPLOYMENT.md | `1000` |
| `STORAGE_GUARD`, `STORAGE_LIMIT_MB`, `STORAGE_GUARD_THRESHOLD`, `STORAGE_OTHER_DB_RESERVE_MB` | Refuse NEW rooms near the cluster's storage limit (never deletes data); see DEPLOYMENT.md | `on`, `512`, `0.8`, `0` |
| `TRUST_PROXY` | Number of reverse proxies you trust in front of the app (`true` = 1, `false`/unset = 0, or 1-10). Only the `X-Forwarded-For` entries those proxies appended (counted from the right) are used | `0` |

Frontend (`frontend/.env.local`, optional in development; **required in production**, see
[DEPLOYMENT.md](DEPLOYMENT.md)): `VITE_API_URL` (dev default `http://localhost:5000`), `VITE_WS_URL` (dev default
`ws://localhost:5000`; `/ws` is appended automatically) and `VITE_PUBLIC_APP_URL` (dev default `http://localhost:5173`;
used for share links). A production build never falls back to `localhost`; it shows a configuration page instead.
Never put secrets in frontend variables. `.env` files are git-ignored; the server never logs the connection string,
password or document contents.

In `NODE_ENV=production` the backend refuses to start with a missing/wildcard/non-HTTPS `ALLOWED_ORIGINS` (or legacy `CLIENT_URL`) or an invalid `TRUST_PROXY`.

## Run

```powershell
# Terminal 1 - API + WebSocket server
cd backend
npm install
npm run dev

# Terminal 2 - website
cd frontend
npm install
npm run dev
```

Open http://localhost:5173/demo-room in two browsers (or a normal and a private window) and type.

## Tests

```powershell
# Backend
cd backend
npm test            # REST + collaboration + production-config tests (in-memory MongoDB), plus the Atlas files if .env is configured
npm run test:atlas  # only the REAL-Atlas tests, database "dropdrop_test"

# Frontend
cd frontend
npm test            # deployment-config rules (URL validation, no localhost in production)
npm run build

# VS Code extension (needs backend/.env with a real Atlas URI; uses the isolated "dropdrop_test" database)
cd vscode-extension
npm run typecheck
npm run test:unit   # validation parity, URL rules, services against the REAL backend process
npm run test:vscode # same commands inside a real VS Code extension host (downloads a separate VS Code on first run)
npm run package     # builds dropdrop-<version>.vsix (does not publish)

# Cross-platform (website <-> VS Code <-> VS Code) and production-build checks
cd vscode-extension; npm run build; node esbuild.mjs --tests   # builds what the e2e tests import
cd ../e2e; npm install; npm test                                 # crossplatform.mjs
node production-build.mjs                                        # Vercel-style production build checks
```

* Backend tests cover the REST API, DB-failure handling, and real WebSocket collaboration with the real `y-websocket`
  client: sync both ways, concurrent edits, isolation, persistence, reconnect, restart and crash recovery, invalid names,
  malformed messages, size/rate/connection limits, cleanup, and REST/Phase 2 migration.
* Atlas-backed tests are skipped (never reported as passed) until `.env` has a real URI. They use the separate
  `dropdrop_test` database and uniquely named rooms, and delete only what they created. They never use the in-memory database.
* The first backend `npm test` downloads a MongoDB server binary (~500 MB, cached).
* Browser tests use Playwright's Chromium (`npx playwright install chromium`).

## REST API

Base URL `http://localhost:5000`; errors are `{ "error": { "code", "message" } }`. Room names: 1–64 chars, letters,
numbers, `-`, `_`, starting with a letter or number; case-sensitive.

| Method & path | Description |
| --- | --- |
| `GET /api/health` | Liveness + DB status (`503` if the DB is down) |
| `POST /api/rooms` | `{ roomName }` – create if missing, else return it (`201` / `200`) |
| `GET /api/rooms/:roomName` | Current room (`404 ROOM_NOT_FOUND`) |
| `PUT /api/rooms/:roomName` | `{ content?, language? }` – merged into the live document (`413` above 500,000 chars) |

Limits: content ≤ 500,000 chars; REST rate limits 300 reads / 120 writes per minute per IP.
WebSocket limits (per process): 2 MB per message, 8 MB per document, 1 MB per update, 20 connections per IP,
50 clients per room, 1,000 total, 100 messages/s sustained (burst 200) per connection, 120 new connections/min per IP.

## Known limitations

* **Single backend instance** (in-process room registry). Horizontal scaling needs Redis (or similar) pub/sub.
* **No access control**: anyone who knows a room name can read and edit it. Use unguessable names for private content.
* A hard server crash can lose up to one persistence interval (default 1 s) of edits that no connected client re-sends (see Durability).
* Plain-text only (no rich text). Presence uses throwaway per-tab names ("Swift Fox"); there are no accounts.
* The Yjs history grows with edits until compaction; documents are capped at 8 MB encoded / 500,000 characters.
* Clearing a room clears it for everyone (undo with Ctrl+Z in the tab that cleared it, while it is still open).
* Not yet tested: Safari/Firefox, more than ~10 simultaneous clients per room, or multi-instance deployments.

## Roadmap

1. Monorepo + website UI ✅
2. Backend, MongoDB Atlas, room REST APIs ✅
3. Yjs real-time collaboration ✅
4. VS Code extension ✅ (webview editor, commands, settings, VSIX) + deployment preparation ✅ (not deployed)
5. **Next:** broader cross-client testing and the actual deployment (see [DEPLOYMENT.md](DEPLOYMENT.md))
6. Deployment (Vercel frontend + persistent backend host) and Marketplace publishing (manual steps in DEPLOYMENT.md)

## VS Code extension

See [vscode-extension/README.md](vscode-extension/README.md). Architecture in one paragraph: the **extension host** owns
the single WebSocket connection and the shared `Y.Doc` (`CollaborationSession`, the same `y-websocket` protocol and
persistence acknowledgements the website uses). The **webview** hosts a CodeMirror 6 editor bound to a *replica* of that
document with its own Yjs client id; `WebviewRelay` forwards Yjs updates and awareness both ways through `postMessage`.
Hosting the connection in the extension host (which sends no `Origin` header) means the webview needs no network access,
strict CSP applies, and the server's origin validation stays strict for browsers.
