import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { config } from "../config";

/**
 * One tiny interface over PostgreSQL:
 *  - production: DATABASE_URL (Supabase, Neon, Render Postgres...) through a connection pool;
 *  - local development with no DATABASE_URL: PGlite, a real Postgres running inside this process, saved to server/data/pgdata.
 * The SQL is the same in both.
 */
export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  kind: "postgres" | "pglite";
};

pg.types.setTypeParser(20, (v: string) => Number(v)); // bigint comes back as a number, not a string

function open(): Db {
  if (config.databaseUrl) {
    const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8, ssl: local ? false : { rejectUnauthorized: false } });
    pool.on("error", (e) => console.error("[db] idle client error", e.message));
    return {
      kind: "postgres",
      query: async <T,>(sql: string, params: unknown[] = []) => (await pool.query(sql, params as unknown[])).rows as T[],
      exec: async (sql: string) => void (await pool.query(sql)),
    };
  }
  mkdirSync(config.localDbDir, { recursive: true });
  const lite = new PGlite(config.localDbDir);
  return {
    kind: "pglite",
    query: async <T,>(sql: string, params: unknown[] = []) => (await lite.query(sql, params)).rows as T[],
    exec: async (sql: string) => void (await lite.exec(sql)),
  };
}

export const db = open();

/** Apply any new *.sql files in db/migrations, in name order, exactly once each. */
export async function migrate() {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DOUBLE PRECISION NOT NULL)");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const dir = join(__dirname, "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    await db.exec(`BEGIN;\n${readFileSync(join(dir, file), "utf8")}\nINSERT INTO schema_migrations (name, applied_at) VALUES ('${file}', ${Date.now()});\nCOMMIT;`);
    console.log(`[db] applied ${file} (${db.kind})`);
  }
}
