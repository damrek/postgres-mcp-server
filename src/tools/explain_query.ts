import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';
import { checkReadOnlySql } from '../sql-guard.js';

export function registerExplainQuery(server: McpServer): void {
  server.registerTool(
    'postgres_explain_query',
    {
      title: 'Explain PostgreSQL Query',
      description: `Return the PostgreSQL execution plan for a read-only statement as JSON.

IMPORTANT: analyze: true executes the statement with EXPLAIN ANALYZE. The statement is still validated as read-only and runs inside a read-only transaction, and execution is bounded by the server's statement_timeout.

Args:
  - sql (string): Read-only statement to explain (SELECT, WITH, TABLE, or VALUES).
  - analyze (boolean, optional): Execute the statement to include actual runtimes and buffer usage (default: false).
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  The execution plan as pretty-printed JSON, matching structuredContent.plan.

Example:
  - "Why is this SELECT slow?" -> sql="SELECT * FROM orders WHERE customer_id = 1"
  - "Show the actual plan" -> sql="SELECT * FROM orders", analyze=true

Error Handling:
  - Rejects writes, DDL, SELECT INTO, locking clauses, and statement stacking
  - Returns an error when EXPLAIN produces no plan`,
      inputSchema: {
        sql: z.string().min(1).describe('Read-only statement to explain'),
        analyze: z
          .boolean()
          .default(false)
          .describe('Execute the statement with EXPLAIN ANALYZE to report actual runtimes and buffers'),
        database: z
          .string()
          .optional()
          .describe('Database name (optional, uses DB_NAME env if omitted)'),
      },
      outputSchema: {
        plan: z.unknown(),
        analyze: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const validation = checkReadOnlySql(`EXPLAIN ${params.sql}`);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: `Error: ${validation.reason}` }],
          isError: true,
        };
      }

      try {
        const explainSql = params.analyze
          ? `EXPLAIN (FORMAT JSON, ANALYZE true, BUFFERS true) ${params.sql}`
          : `EXPLAIN (FORMAT JSON) ${params.sql}`;
        const result = await query(explainSql, undefined, params.database);

        if (result.rows.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: EXPLAIN returned no query plan.' }],
            isError: true,
          };
        }

        const plan: unknown = result.rows[0]?.['QUERY PLAN'];

        return {
          content: [{ type: 'text', text: JSON.stringify(plan, null, 2) ?? 'null' }],
          structuredContent: { plan, analyze: params.analyze },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error generating query plan: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
