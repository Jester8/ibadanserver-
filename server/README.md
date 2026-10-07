# Omo Ibadan backend

One Node process serves **HTTP (REST)** and **WebSocket (realtime)** on the same port (default `8787`).

```
server/
  index.ts            entry: boots HTTP + WebSocket, presence, chat, voice signalling, calls, election
  config.ts           environment config (see ../.env.example)
  db/index.ts         Postgres (Supabase) via pg, or in-process PGlite when DATABASE_URL is empty; migration runner
  db/migrations/      numbered .sql files, applied once each at start-up
  db/repo.ts          all SQL lives here: players, plots, reports, elections, cloud saves
  http/router.ts      REST routes, CORS, body limits, rate limit, state sanitising
  http/auth.ts        signed guest tokens (pid.signature)
```

Requires **Node 22+**. With no `DATABASE_URL` it runs a local Postgres (PGlite) in `server/data/pgdata`, so nothing to install.
Deploying: see [../docs/DEPLOY.md](../docs/DEPLOY.md). Run: `npm run server`, or `npm run dev:all` with the web app.

## REST API

All routes except `/health`, auth and the public track list need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| POST | `/api/auth/request-code` | `{email, purpose: "login"|"signup"}` emails a 6-digit code (10 min, 30 s resend gap, 5 per hour) |
| POST | `/api/auth/verify` | `{email, code, name?, look?}` existing email logs in; a new one creates the account. Returns a 30-day token |
| POST | `/api/auth/guest` | legacy anonymous players only; refuses an id that already exists |
| GET / PUT | `/api/state` | cloud save |
| POST | `/api/voice/token` | `{room, id}` LiveKit ticket for a voice room (404 when LiveKit is not configured, so the game falls back to peer-to-peer) |
| GET | `/api/rtc` | ICE servers for voice: STUN, plus TURN with short-lived credentials when `TURN_URLS` + `TURN_SECRET` are set |
| GET | `/api/friends` | friends (with online flag), incoming and outgoing requests, blocked ids |
| POST | `/api/friends/request`, `/api/friends/respond` | send, accept or decline; `DELETE /api/friends/:pid` removes |
| GET / POST / DELETE | `/api/blocks` | block list; blocking also unfriends |
| GET | `/api/dm/threads`, `/api/dm/:pid` | conversations and history (marks read); `POST /api/dm/:pid` sends |
| GET | `/api/players/:pid` | public profile card with your friendship status |
| GET / POST / DELETE | `/api/tracks…`, `/api/admin/tracks…` | artist music platform |

### WebSocket messages (selected)

`hello` (with token) · `room` → server replies with `history` · `chat` (saved, blocked senders filtered) · `dm` (friends only) →
`dm` echoed to both sides · `presence` to friends on connect/disconnect · `friendEvent` · `call` / `signal` / `voiceJoin` (voice).

## Authentication

* **No verification by default.** Sign up takes a username, a name, an email and an avatar and lets the player straight in; log in takes the email or the username.
  Anyone who knows an email or username can log in as that player, so turn on codes (`EMAIL_CODES=1` plus `SMTP_URL`) before a public launch.

* Sign up and log in both use an **emailed one-time code**. There are no passwords.
* Without `SMTP_URL` (local development) the code is printed in the server log and returned as `devCode` so you can test.
  In production (`NODE_ENV=production`) it is **never** returned.
* Accounts with a verified email can only connect over the websocket with a valid token. Tokens expire after 30 days
  and the client sends the player back to log in.

## Data

Postgres tables: `players`, `auth_codes`, `plots`, `friendships`, `blocks`, `dms`, `room_messages`, `tracks`, `reports`, `elections`.
Add a migration by creating `db/migrations/002_whatever.sql`; never edit one that has shipped.
The first start imports an old `server/plots.json` if it exists.

## Security status (read before a public launch)

* Email codes prove an email address belongs to the player. Set `SMTP_URL`, `AUTH_SECRET` and `REQUIRE_AUTH=1` in production.
* **Money and needs are still computed in the browser.** `PUT /api/state` clamps values but cannot stop a determined cheater.
  The next step is server-authoritative actions (`runAction`, rent, purchases).
* Chat is filtered with a short word list (`src/lib/moderation.ts`). Extend it for Yoruba and Pidgin and add review tools.
* Voice is peer-to-peer WebRTC. Run a **TURN server** (coturn) and set `TURN_URLS` + `TURN_SECRET` so calls work on strict networks.

## Deploy

`docker build -f Dockerfile.server -t omo-ibadan-server .` then run with a volume on `/data`
and `AUTH_SECRET`, `ALLOWED_ORIGINS`, `REQUIRE_AUTH=1`. Put it behind TLS (wss/https).
