import type { QueryResultRow } from 'pg';
import { query } from './db.js';

export const PUBLIC_SCHEMA = 'public';

export interface CatalogQuery {
  sql: string;
  params: unknown[];
}

/**
 * Resolves a schema name the same way PostgreSQL parses identifiers: unquoted
 * names fold to lowercase, while double-quoted names keep their case.
 * Returns null when the schema does not exist.
 */
export async function resolveSchemaName(schema: string, database?: string): Promise<string | null> {
  const result = await query(
    'SELECT nspname FROM pg_namespace WHERE oid = to_regnamespace($1)',
    [schema],
    database
  );
  return (result.rows[0]?.nspname as string | undefined) ?? null;
}

export interface Relationship {
  constraint_name: string;
  source_schema: string;
  source_table: string;
  source_column: string;
  target_schema: string;
  target_table: string;
  target_column: string;
}

export type ConstraintType = 'PRIMARY KEY' | 'UNIQUE' | 'CHECK' | 'FOREIGN KEY';

export interface Constraint {
  type: ConstraintType;
  name: string;
  columns?: string[];
  check_clause?: string;
  definition?: string;
}

export interface IndexDefinition {
  name: string;
  definition: string;
}

const CONSTRAINT_TYPES: Record<string, ConstraintType> = {
  p: 'PRIMARY KEY',
  u: 'UNIQUE',
  c: 'CHECK',
  f: 'FOREIGN KEY',
};

export function columnsQuery(tableName: string, schema = PUBLIC_SCHEMA): CatalogQuery {
  return {
    sql: `SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_name = $1 AND table_schema = $2
          ORDER BY ordinal_position`,
    params: [tableName, schema],
  };
}

export function constraintsQuery(tableName: string, schema = PUBLIC_SCHEMA): CatalogQuery {
  return {
    sql: `SELECT
            con.conname AS constraint_name,
            con.contype AS constraint_type,
            att.attname AS column_name,
            pair.position,
            pg_get_constraintdef(con.oid) AS definition
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS pair(attnum, position) ON true
          LEFT JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = pair.attnum
          WHERE rel.relname = $1
            AND ns.nspname = $2
            AND con.contype IN ('p', 'u', 'c', 'f')
          ORDER BY
            CASE con.contype
              WHEN 'p' THEN 1
              WHEN 'u' THEN 2
              WHEN 'c' THEN 3
              WHEN 'f' THEN 4
            END,
            con.conname,
            pair.position`,
    params: [tableName, schema],
  };
}

export function indexesQuery(tableName: string, schema = PUBLIC_SCHEMA): CatalogQuery {
  return {
    sql: `SELECT indexname, indexdef
          FROM pg_indexes
          WHERE tablename = $1 AND schemaname = $2
          ORDER BY indexname`,
    params: [tableName, schema],
  };
}

export interface RelationshipQueryOptions {
  tableName?: string;
}

export function relationshipsQuery(options: RelationshipQueryOptions = {}): CatalogQuery {
  const conditions = [
    "con.contype = 'f'",
    "source_ns.nspname NOT IN ('pg_catalog', 'information_schema')",
  ];
  const params: unknown[] = [];
  const tableName = options.tableName;

  if (tableName) {
    const parts = tableName.split('.');
    if (parts.length === 2) {
      params.push(parts[0], parts[1]);
      conditions.push(
        '((source_ns.nspname = $1 AND source.relname = $2) OR (target_ns.nspname = $1 AND target.relname = $2))'
      );
    } else {
      params.push(tableName);
      conditions.push('(source.relname = $1 OR target.relname = $1)');
    }
  }

  return {
    sql: `SELECT
            con.conname AS constraint_name,
            source_ns.nspname AS source_schema,
            source.relname AS source_table,
            source_att.attname AS source_column,
            target_ns.nspname AS target_schema,
            target.relname AS target_table,
            target_att.attname AS target_column
          FROM pg_constraint con
          JOIN pg_class source ON source.oid = con.conrelid
          JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
          JOIN pg_class target ON target.oid = con.confrelid
          JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
          JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY
            AS pair(source_attnum, target_attnum, position) ON true
          JOIN pg_attribute source_att
            ON source_att.attrelid = con.conrelid AND source_att.attnum = pair.source_attnum
          JOIN pg_attribute target_att
            ON target_att.attrelid = con.confrelid AND target_att.attnum = pair.target_attnum
          WHERE ${conditions.join('\n            AND ')}
          ORDER BY source_ns.nspname, source.relname, con.conname, pair.position`,
    params,
  };
}

export function mapRelationships(rows: QueryResultRow[]): Relationship[] {
  return rows.map((row) => ({
    constraint_name: row.constraint_name as string,
    source_schema: row.source_schema as string,
    source_table: row.source_table as string,
    source_column: row.source_column as string,
    target_schema: row.target_schema as string,
    target_table: row.target_table as string,
    target_column: row.target_column as string,
  }));
}

export function mapConstraints(rows: QueryResultRow[]): Constraint[] {
  const constraints = new Map<string, Constraint>();

  for (const row of rows) {
    const name = row.constraint_name as string;
    const type = CONSTRAINT_TYPES[row.constraint_type as string];
    if (!type) {
      continue;
    }

    let constraint = constraints.get(name);
    if (!constraint) {
      const definition = (row.definition as string | null) ?? undefined;
      constraint = { type, name, columns: [], definition };
      if (type === 'CHECK') {
        constraint.check_clause = definition;
      }
      constraints.set(name, constraint);
    }

    if (row.column_name) {
      constraint.columns!.push(row.column_name as string);
    }
  }

  return Array.from(constraints.values());
}

export function mapIndexes(rows: QueryResultRow[]): IndexDefinition[] {
  return rows.map((row) => ({
    name: row.indexname as string,
    definition: row.indexdef as string,
  }));
}
