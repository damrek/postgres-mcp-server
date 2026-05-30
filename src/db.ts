import pg from 'pg';
import { DEFAULT_DB_HOST, DEFAULT_DB_PORT, DEFAULT_DB_USER } from './constants.js';

const { Pool } = pg;

interface PoolConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  max: number;
}

function getBaseConfig(): PoolConfig {
  const config: PoolConfig = {
    host: process.env.DB_HOST || DEFAULT_DB_HOST,
    port: parseInt(process.env.DB_PORT || String(DEFAULT_DB_PORT), 10),
    user: process.env.DB_USER || DEFAULT_DB_USER,
    max: 5,
  };

  const password = process.env.DB_PASSWORD;
  if (password) {
    config.password = password;
  }

  return config;
}

const pools = new Map<string, pg.Pool>();

function getPool(database?: string): pg.Pool {
  const dbName = database || process.env.DB_NAME;
  const key = dbName || '__default__';

  if (!pools.has(key)) {
    const config = getBaseConfig();
    if (dbName) {
      config.database = dbName;
    }
    pools.set(key, new Pool(config));
  }

  return pools.get(key)!;
}

export interface QueryResult {
  rows: pg.QueryResultRow[];
  rowCount: number | null;
  fields: pg.FieldDef[];
}

export async function query(sql: string, params?: unknown[], database?: string): Promise<QueryResult> {
  const pool = getPool(database);
  const result = await pool.query(sql, params);
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    fields: result.fields,
  };
}

export async function closeAll(): Promise<void> {
  for (const pool of pools.values()) {
    await pool.end();
  }
  pools.clear();
}
