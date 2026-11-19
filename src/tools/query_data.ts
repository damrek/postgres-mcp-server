import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queryLimited } from '../db.js';
import { CHARACTER_LIMIT } from '../constants.js';
import { checkReadOnlySql } from '../sql-guard.js';

export function registerQueryData(server: McpServer): void {
  server.registerTool(
    'postgres_query_data',
    {
      title: 'Query PostgreSQL Data',
      description: `Execute a single read-only query against a PostgreSQL database.

IMPORTANT: Only read-only statements are allowed (SELECT, WITH, TABLE, VALUES, SHOW, EXPLAIN). INSERT, UPDATE, DELETE, DDL, multiple statements, SELECT INTO, and EXPLAIN ANALYZE of writes are rejected.

Args:
  - sql (string): The SELECT query to execute. Use $1, $2, etc. for parameters.
  - params (array, optional): Parameter values for $1, $2, etc.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.
  - limit (number, optional): Max rows to return (default: 100, max: 1000).

Returns:
  Query results as rows with column headers.

Example:
  - "SELECT * FROM users WHERE active = $1" with params [true]
  - "SELECT name, email FROM customers LIMIT 10"

Error Handling:
  - Rejects non-read-only queries and statement stacking
  - Returns error for syntax errors or invalid tables`,
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe('SELECT query to execute (use $1, $2 for parameters)'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Parameter values for $1, $2, etc.'),
        database: z
          .string()
          .optional()
          .describe('Database name (optional, uses DB_NAME env if omitted)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe('Maximum rows to return (default: 100, max: 1000)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const validation = checkReadOnlySql(params.sql);
      if (!validation.valid) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${validation.reason}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await queryLimited(params.sql, params.params, params.limit, params.database);
        const fields = result.fields.map((f) => f.name);
        const rows = result.rows;

        if (rows.length === 0) {
          return {
            content: [{ type: 'text', text: 'Query returned 0 rows.' }],
            structuredContent: { rows: [], count: 0, fields, truncated: false },
          };
        }

        const jsonStr = JSON.stringify({ rows, count: rows.length, fields }, null, 2);
        const sizeLimited = jsonStr.length > CHARACTER_LIMIT;
        const outputRows = sizeLimited ? rows.slice(0, Math.max(1, Math.floor(rows.length / 2))) : rows;
        const truncated = result.truncated || sizeLimited;

        let textOutput = result.truncated
          ? `Query returned more than the ${params.limit} row limit. Showing the first ${rows.length}.\n\n`
          : `Query returned ${rows.length} row(s):\n\n`;

        if (sizeLimited) {
          textOutput = `Query returned ${rows.length} row(s). Showing the first ${outputRows.length} (response too large).\n\n`;
        }

        textOutput += formatRowsAsTable(fields, outputRows);

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: { rows: outputRows, count: rows.length, fields, truncated },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Query error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

function formatRowsAsTable(fields: string[], rows: Record<string, unknown>[]): string {
  const lines: string[] = [];
  lines.push(`| ${fields.join(' | ')} |`);
  lines.push(`| ${fields.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${fields.map((f) => String(row[f] ?? 'NULL')).join(' | ')} |`);
  }
  return lines.join('\n');
}
