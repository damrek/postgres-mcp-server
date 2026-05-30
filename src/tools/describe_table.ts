import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';

export function registerDescribeTable(server: McpServer): void {
  server.registerTool(
    'postgres_describe_table',
    {
      title: 'Describe PostgreSQL Table',
      description: `Get the structure of a table including columns, data types, nullability, and defaults.

Args:
  - table_name (string): Name of the table to describe.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  Column details: name, data type, nullable, default value.

Example:
  - Use when: "What columns does the users table have?"
  - Use when: "Show me the structure of the orders table"

Error Handling:
  - Returns an error if the table doesn't exist`,
      inputSchema: {
        table_name: z.string().describe('Name of the table to describe'),
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
        const result = await query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public'
           ORDER BY ordinal_position`,
          [params.table_name],
          params.database
        );

        if (result.rows.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No columns found for table '${params.table_name}'. Table may not exist or is not in the public schema.`,
              },
            ],
          };
        }

        const columns = result.rows.map((r) => ({
          name: r.column_name as string,
          type: r.data_type as string,
          nullable: (r.is_nullable as string) === 'YES',
          default: r.column_default as string | null,
        }));

        const lines = [`## Table: ${params.table_name}\n`];
        for (const col of columns) {
          lines.push(`- **${col.name}**: ${col.type}${col.nullable ? ' (nullable)' : ' (not null)'}`);
          if (col.default) lines.push(`  Default: ${col.default}`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { table: params.table_name, columns },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error describing table: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
