// src/lib/dbPool.ts
//
// THE shared Postgres pool. Every API route, layout, and lib must use this
// instead of constructing its own `new Pool()` — module-level pools multiply
// per route file and eat the database's connection cap under load.
//
// Plain module (no 'use server') so it can be imported from route handlers,
// server components, and libs alike.

import { Pool } from "pg"

let _pool: Pool | null = null

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: false },
    })
  }
  return _pool
}
