# ibadanserver

Realtime + REST server for **Omo Ibadan** (the game lives in a separate repo and is deployed on Vercel).

One Node process serves HTTP and WebSocket on the same port. Data is in Postgres (Supabase), music files in Supabase Storage, voice through LiveKit Cloud.

```
npm install
cp .env.example .env     # leave DATABASE_URL empty to use a local in-process Postgres
npm run dev              # http/ws on :8787
npm run typecheck
```

- API, messages and data model: [server/README.md](server/README.md)
- Deploying on Render + Supabase + LiveKit, and the test checklist: [docs/DEPLOY.md](docs/DEPLOY.md)

`src/lib/{protocol,look,moderation}.ts` are shared message types and helpers; keep them in step with the same files in the game repo.
