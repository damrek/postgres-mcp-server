import pg from 'pg';
import Cursor from 'pg-cursor';
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

export function statementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.DB_STATEMENT_TIMEOUT, DEFAULT_STATEMENT_TIMEOUT_MS);
}

export function buildPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const config: PoolConfig = {
    host: env.DB_HOST || DEFAULT_DB_HOST,
    port: positiveInteger(env.DB_PORT, DEFAULT_DB_PORT, 65535),
    user: env.DB_USER || DEFAULT_DB_USER,
    max: MAX_POOL_CONNECTIONS,
    application_name: 'postgres-mcp-server',
    statement_timeout: statementTimeoutMs(env),
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

export interface LimitedQueryResult extends QueryResult {
  truncated: boolean;
}

function readCursor(
  cursor: Cursor,
  count: number
): Promise<{ rows: pg.QueryResultRow[]; fields: pg.FieldDef[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (error, rows, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ rows, fields: result.fields });
    });
  });
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
      const timedConfig = {
        text: sql,
        values: params,
        query_timeout: statementTimeoutMs() + QUERY_TIMEOUT_MARGIN_MS,
      } as pg.QueryConfig & { query_timeout: number };
      const result = await client.query(timedConfig);
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

/**
 * Reads at most `limit + 1` rows with a server-side cursor, so the row limit is
 * enforced without rewriting the SQL. The extra row only detects truncation.
 */
export async function queryLimited(
  sql: string,
  params: unknown[] | undefined,
  limit: number,
  database?: string
): Promise<LimitedQueryResult> {
  const validation = checkReadOnlySql(sql);
  if (!validation.valid) {
    throw new Error(`Query rejected: ${validation.reason}`);
  }

  const pool = getPool(database);
  const client = await pool.connect();
  let cursor: Cursor | undefined;

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    cursor = client.query(new Cursor(sql, params ?? []));
    const { rows, fields } = await readCursor(cursor, limit + 1);
    await cursor.close();
    await client.query('COMMIT');

    const truncated = rows.length > limit;
    const limitedRows = truncated ? rows.slice(0, limit) : rows;

    return {
      rows: limitedRows,
      rowCount: limitedRows.length,
      fields,
      truncated,
    };
  } catch (error) {
    if (cursor) {
      await cursor.close().catch(() => undefined);
    }
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
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
