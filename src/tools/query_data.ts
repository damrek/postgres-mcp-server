import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';
import { CHARACTER_LIMIT } from '../constants.js';

export function registerQueryData(server: McpServer): void {
  server.registerTool(
    'postgres_query_data',
    {
      title: 'Query PostgreSQL Data',
      description: `Execute a read-only SELECT query against a PostgreSQL database.

IMPORTANT: Only SELECT queries are allowed. Any INSERT, UPDATE, DELETE, DROP, ALTER, or CREATE statements will be rejected.

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
  - Rejects non-SELECT queries
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
      const trimmedSql = params.sql.trim().toUpperCase();
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXECUTE'];
      for (const keyword of forbidden) {
        if (trimmedSql.startsWith(keyword + ' ') || trimmedSql.startsWith(keyword + '\n')) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Only SELECT queries are allowed. Detected '${keyword}' statement.`,
              },
            ],
            isError: true,
          };
        }
      }

      try {
        const limitedSql = params.sql.trim().replace(/;$/, '');
        const hasLimit = /\bLIMIT\s+\d+/i.test(limitedSql);
        const finalSql = hasLimit ? limitedSql : `${limitedSql} LIMIT ${params.limit}`;

        const result = await query(finalSql, params.params, params.database);

        if (result.rows.length === 0) {
          return {
            content: [{ type: 'text', text: 'Query returned 0 rows.' }],
            structuredContent: { rows: [], count: 0, fields: result.fields.map((f) => f.name) },
          };
        }

        const fields = result.fields.map((f) => f.name);
        const rows = result.rows;

        let textOutput: string;
        let output = { rows, count: rows.length, fields };

        const jsonStr = JSON.stringify(output, null, 2);
        if (jsonStr.length > CHARACTER_LIMIT) {
          const halfRows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
          output = { rows: halfRows, count: rows.length, fields };
          textOutput = `Query returned ${rows.length} rows. Showing first ${halfRows.length} (response too large).\n\n`;
          textOutput += formatRowsAsTable(fields, halfRows);
        } else {
          textOutput = `Query returned ${rows.length} row(s):\n\n`;
          textOutput += formatRowsAsTable(fields, rows);
        }

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: output,
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
