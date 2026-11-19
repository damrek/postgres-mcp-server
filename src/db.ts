import pg from 'pg';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_DB_HOST,
  DEFAULT_DB_PORT,
  DEFAULT_DB_USER,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MAX_POOL_CONNECTIONS,
  QUERY_TIMEOUT_MARGIN_MS,
} from './constants.js';
import { checkReadOnlySql } from './sql-guard.js';

const { Pool } = pg;

export interface PoolConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  max: number;
  application_name: string;
  statement_timeout: number;
  query_timeout: number;
  connectionTimeoutMillis: number;
  options: string;
}

function positiveInteger(value: string | undefined, fallback: number, max?: number): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  if (max !== undefined && parsed > max) {
    return fallback;
  }
  return parsed;
}

export function buildPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const statementTimeout = positiveInteger(env.DB_STATEMENT_TIMEOUT, DEFAULT_STATEMENT_TIMEOUT_MS);
  const config: PoolConfig = {
    host: env.DB_HOST || DEFAULT_DB_HOST,
    port: positiveInteger(env.DB_PORT, DEFAULT_DB_PORT, 65535),
    user: env.DB_USER || DEFAULT_DB_USER,
    max: MAX_POOL_CONNECTIONS,
    application_name: 'postgres-mcp-server',
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + QUERY_TIMEOUT_MARGIN_MS,
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECT_TIMEOUT, DEFAULT_CONNECT_TIMEOUT_MS),
    options: '-c default_transaction_read_only=on',
  };

  if (env.DB_PASSWORD) {
    config.password = env.DB_PASSWORD;
  }
  if (env.DB_NAME) {
    config.database = env.DB_NAME;
  }

  return config;
}

const pools = new Map<string, pg.Pool>();

function getPool(database?: string): pg.Pool {
  const dbName = database || process.env.DB_NAME;
  const key = dbName || '__default__';

  let pool = pools.get(key);
  if (!pool) {
    const config = buildPoolConfig();
    if (database) {
      config.database = database;
    }
    pool = new Pool(config);
    pool.on('error', (error) => {
      console.error(`Unexpected PostgreSQL client error (${key}):`, error.message);
    });
    pools.set(key, pool);
  }

  return pool;
}

export interface QueryResult {
  rows: pg.QueryResultRow[];
  rowCount: number | null;
  fields: pg.FieldDef[];
}

export async function query(sql: string, params?: unknown[], database?: string): Promise<QueryResult> {
  const validation = checkReadOnlySql(sql);
  if (!validation.valid) {
    throw new Error(`Query rejected: ${validation.reason}`);
  }

  const pool = getPool(database);
  const client = await pool.connect();

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    try {
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function closeAll(): Promise<void> {
  for (const pool of pools.values()) {
    await pool.end();
  }
  pools.clear();
}
