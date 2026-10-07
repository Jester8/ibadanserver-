import { join } from "node:path";

const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

/** All runtime configuration comes from the environment (see .env.example). */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** PostgreSQL connection string (Supabase "Session pooler"). Empty = a local in-process Postgres (PGlite) for development. */
  databaseUrl: process.env.DATABASE_URL ?? "",
  localDbDir: process.env.LOCAL_DB_DIR ?? join(__dirname, "data", "pgdata"),
  /** signs player tokens; MUST be set to a long random string in production */
  authSecret: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  /** when true the websocket refuses players without a valid token */
  requireAuth: process.env.REQUIRE_AUTH === "1",
  origins: list(process.env.ALLOWED_ORIGINS, "http://localhost:3000,http://localhost:3100"),
  production: process.env.NODE_ENV === "production",
  /** e.g. smtps://user:pass@smtp.example.com:465 . Without it, codes are only printed to the server log (development). */
  smtpUrl: process.env.SMTP_URL ?? "",
  mailFrom: process.env.MAIL_FROM ?? "Omo Ibadan <no-reply@omoibadan.app>",
  /** voice relay (coturn "use-auth-secret"). Leave empty to use STUN only. */
  turnUrls: (process.env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  turnSecret: process.env.TURN_SECRET ?? "",
  /** LiveKit Cloud (free tier) carries voice for bigger rooms. Without these, voice falls back to peer-to-peer. */
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitSecret: process.env.LIVEKIT_API_SECRET ?? "",
  /** reviews uploaded tracks; MUST be set to something long and secret in production */
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
  /** the intro song lives outside git; in production it is only served when you assert you hold the licence */
  introDir: process.env.INTRO_DIR ?? join(__dirname, "data", "intro"),
  introLicensed: process.env.INTRO_LICENSED === "1",
  /** Supabase Storage for uploaded music (create a private bucket). Empty = files go to a local folder. */
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ?? "",
  supabaseBucket: process.env.SUPABASE_BUCKET ?? "tracks",
  tracksDir: process.env.TRACKS_DIR ?? join(__dirname, "data", "tracks"),
};

if (config.production && config.adminToken === "dev-admin-token") {
  throw new Error("ADMIN_TOKEN must be set in production");
}
if (config.production && config.authSecret === "dev-secret-change-me") {
  throw new Error("AUTH_SECRET must be set in production");
}
