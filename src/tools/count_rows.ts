import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';
import { PUBLIC_SCHEMA } from '../catalog.js';
import { checkTableName, checkWhereClause } from '../sql-guard.js';

interface ResolvedTable {
  schema: string;
  table: string;
}

function resolveTable(tableName: string): ResolvedTable {
  const parts = tableName.split('.');
  // PostgreSQL folds unquoted identifiers to lowercase, and checkTableName
  // rejects quoted names, so the catalog lookup must fold the same way.
  if (parts.length === 2) {
    return { schema: parts[0].toLowerCase(), table: parts[1].toLowerCase() };
  }
  return { schema: PUBLIC_SCHEMA, table: tableName.toLowerCase() };
}

export function registerCountRows(server: McpServer): void {
  server.registerTool(
    'postgres_count_rows',
    {
      title: 'Count PostgreSQL Rows',
      description: `Count the total number of rows in a table, with optional WHERE filter.

Args:
  - table_name (string): Name of the table to count. Use table or schema.table.
  - where_clause (string, optional): WHERE condition without the WHERE keyword (e.g., "status = 'active'" or "age > 18").
  - exact (boolean, optional): When true (default), run COUNT(*) for an exact result. When false, return PostgreSQL's reltuples estimate from pg_class, which is cheap on large tables but requires ANALYZE to be accurate.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  The row count, or an approximate row estimate when exact is false.

Example:
  - Count all rows: table_name="users"
  - Count with filter: table_name="users", where_clause="active = true"
  - Count with date: table_name="orders", where_clause="created_at > '2024-01-01'"
  - Fast estimate: table_name="events", exact=false

Error Handling:
  - Returns an error if the table doesn't exist or WHERE clause is invalid
  - exact=false rejects where_clause and reports when no estimate is available`,
      inputSchema: {
        table_name: z.string().min(1).describe('Name of the table to count rows from'),
        where_clause: z
          .string()
          .optional()
          .describe("WHERE condition without the WHERE keyword (e.g., \"status = 'active'\")"),
        exact: z
          .boolean()
          .default(true)
          .describe(
            'Use COUNT(*) when true (default); read the reltuples estimate when false (no where_clause)'
          ),
        database: z
          .string()
          .optional()
          .describe('Database name (optional, uses DB_NAME env if omitted)'),
      },
      outputSchema: {
        table: z.string(),
        schema: z.string(),
        count: z.number(),
        estimated: z.boolean(),
        where_clause: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const tableValidation = checkTableName(params.table_name);
      if (!tableValidation.valid) {
        return {
          content: [{ type: 'text', text: `Error: ${tableValidation.reason}` }],
          isError: true,
        };
      }

      if (!params.exact && params.where_clause !== undefined) {
        return {
          content: [{ type: 'text', text: 'Error: exact=false does not support where_clause.' }],
          isError: true,
        };
      }

      if (params.where_clause) {
        const clauseValidation = checkWhereClause(params.where_clause);
        if (!clauseValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${clauseValidation.reason}` }],
            isError: true,
          };
        }
      }

      const { schema, table } = resolveTable(params.table_name);

      try {
        if (!params.exact) {
          const estimateLookup = await query(
            `SELECT c.reltuples::bigint AS estimate
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = $1
                AND n.nspname = $2
                AND c.relkind IN ('r', 'p')`,
            [table, schema],
            params.database
          );

          if (estimateLookup.rows.length === 0) {
            return {
              content: [
                { type: 'text', text: `Error: Table '${schema}.${table}' not found.` },
              ],
              isError: true,
            };
          }

          const estimate = Number(estimateLookup.rows[0].estimate);
          if (estimate < 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Row count estimate is not available for '${schema}.${table}'. Run ANALYZE and retry.`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: `Table '${schema}.${table}' has approximately ${estimate} row(s) (estimate).`,
              },
            ],
            structuredContent: {
              table: params.table_name,
              schema,
              count: estimate,
              estimated: true,
              where_clause: null,
            },
          };
        }

        const sql = params.where_clause
          ? `SELECT COUNT(*) as count FROM ${params.table_name} WHERE ${params.where_clause}`
          : `SELECT COUNT(*) as count FROM ${params.table_name}`;

        const result = await query(sql, undefined, params.database);
        const count = Number(result.rows[0].count);

        return {
          content: [
            {
              type: 'text',
              text: params.where_clause
                ? `Table '${params.table_name}' has ${count} row(s) matching: ${params.where_clause}`
                : `Table '${params.table_name}' has ${count} row(s) total`,
            },
          ],
          structuredContent: {
            table: params.table_name,
            schema,
            count,
            estimated: false,
            where_clause: params.where_clause || null,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error counting rows: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
