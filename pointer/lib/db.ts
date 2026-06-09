import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

declare global {
  // Reuse the pool across HMR reloads in dev so we don't exhaust Postgres connections.
  var __pgPool: Pool | undefined;
}

export const pool: Pool =
  globalThis.__pgPool ??
  new Pool({
    connectionString: databaseUrl,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__pgPool = pool;
}

// App-level tables go here as we build them out. Better Auth manages its own
// schema directly via the same pool, so we don't need to declare those tables.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type DB = {};

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});
