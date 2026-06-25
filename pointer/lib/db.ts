import { Pool } from "pg";

declare global {
  // Reuse the pool across HMR reloads in dev so we don't exhaust Postgres connections.
  var __pgPool: Promise<Pool> | undefined;
}

// Pool creation is deferred to first use so that importing this module during
// `next build` (page-data collection) doesn't require DATABASE_URL to be set.
// The env-var check still fires fail-fast on the first query at runtime.
let cachedPool: Promise<Pool> | undefined;

export function getPool(): Promise<Pool> {
  if (globalThis.__pgPool) return globalThis.__pgPool;
  if (cachedPool) return cachedPool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  cachedPool = Promise.resolve(new Pool({
    connectionString: databaseUrl,
    max: 10,
  }));

  if (process.env.NODE_ENV !== "production") {
    globalThis.__pgPool = Promise.resolve(cachedPool);
  }

  return cachedPool;
}
