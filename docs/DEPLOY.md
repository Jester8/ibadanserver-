# Deploying Omo Ibadan

```
Browser (Vercel, Next.js)  --https/wss-->  Render (Node: REST + WebSocket)  --> Supabase Postgres + Storage
        \--------- voice (WebRTC) ---------> LiveKit Cloud
```

You need accounts on **Supabase**, **LiveKit Cloud**, **Render**, **Vercel** and an email sender (**Resend** or **Brevo**, both have free tiers).
Never paste keys into chat, code or git. They go only in the Render / Vercel dashboards.

## 1. Supabase (database + music storage)

1. New project. Pick a region near your players (Europe/Frankfurt is close to Nigeria). Save the database password.
2. **Connect** (top bar) > **Session pooler** > copy the URI, replace `[YOUR-PASSWORD]`. This is `DATABASE_URL`.
3. **Storage** > New bucket > name `tracks`, keep it **private**.
4. **Project Settings > API**: copy the **Project URL** (`SUPABASE_URL`) and the **service_role** key (`SUPABASE_SERVICE_KEY`). Server only.

Tables are created automatically the first time the server starts.

## 2. LiveKit Cloud (voice)

1. cloud.livekit.io > new project.
2. **Settings > Keys** > create a key. Copy the WebSocket URL (`wss://....livekit.cloud`) = `LIVEKIT_URL`, plus `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

## 3. Email (login codes)

Resend: add a domain (or use their test sender), create an API key, then
`SMTP_URL=smtps://resend:API_KEY@smtp.resend.com:465` and `MAIL_FROM=Omo Ibadan <no-reply@yourdomain.com>`.

## 4. Render (the server)

1. New > **Blueprint**, pick this repo; Render reads `render.yaml`. (Or New > Web Service by hand: build `npm ci`, start `npm start`, health check `/health`, Node 24.)
2. Fill the variables marked in the dashboard: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `LIVEKIT_*`, `SMTP_URL`, `MAIL_FROM`,
   and `ALLOWED_ORIGINS` = your Vercel URL (no trailing slash). `AUTH_SECRET` and `ADMIN_TOKEN` are generated for you (copy `ADMIN_TOKEN` to review tracks at `/admin/tracks`).
3. Keep **one instance** on the **Starter** plan (free plan sleeps and kicks live players).
4. Open `https://YOUR-SERVICE.onrender.com/health`. It should answer `ok`. The logs show `[db] applied 001_init.sql (postgres)`.

## 5. Vercel (the game)

Project > Settings > Environment Variables, then redeploy:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_WS_URL` | `wss://YOUR-SERVICE.onrender.com` |
| `NEXT_PUBLIC_API_URL` | `https://YOUR-SERVICE.onrender.com` |
| `NEXT_PUBLIC_REQUIRE_BACKEND` | `1` (real accounts; leave unset to stay in browser-only demo mode) |

## 6. Test checklist

1. Sign up with a real email, receive the 6-digit code, enter it.
2. Open the game in a second browser (or phone) with another email. Walk to the same place.
3. Chat in a room; both see it. Send a friend request, accept, send a DM.
4. Press Talk on both; you hear each other (LiveKit). Toggle mute.
5. Sign out and back in: progress is still there.
6. Upload a track as an artist, approve it at `/admin/tracks`, and play it.

If voice says the microphone is blocked: the page must be https and the browser must have mic permission.
