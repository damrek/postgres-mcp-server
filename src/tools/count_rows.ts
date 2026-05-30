import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';

export function registerCountRows(server: McpServer): void {
  server.registerTool(
    'postgres_count_rows',
    {
      title: 'Count PostgreSQL Rows',
      description: `Count the total number of rows in a table, with optional WHERE filter.

Args:
  - table_name (string): Name of the table to count.
  - where_clause (string, optional): WHERE condition without the WHERE keyword (e.g., "status = 'active'" or "age > 18").
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  The total count of matching rows.

Example:
  - Count all rows: table_name="users"
  - Count with filter: table_name="users", where_clause="active = true"
  - Count with date: table_name="orders", where_clause="created_at > '2024-01-01'"

Error Handling:
  - Returns an error if the table doesn't exist or WHERE clause is invalid`,
      inputSchema: {
        table_name: z.string().min(1).describe('Name of the table to count rows from'),
        where_clause: z
          .string()
          .optional()
          .describe("WHERE condition without the WHERE keyword (e.g., \"status = 'active'\")"),
        database: z
          .string()
          .optional()
          .describe('Database name (optional, uses DB_NAME env if omitted)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        let sql: string;
        let sqlParams: unknown[] | undefined;

        if (params.where_clause) {
          sql = `SELECT COUNT(*) as count FROM ${params.table_name} WHERE ${params.where_clause}`;
        } else {
          sql = `SELECT COUNT(*) as count FROM ${params.table_name}`;
        }

        const result = await query(sql, sqlParams, params.database);
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
            count,
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
