import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';

export function registerListTables(server: McpServer): void {
  server.registerTool(
    'postgres_list_tables',
    {
      title: 'List PostgreSQL Tables',
      description: `List all tables in a database's public schema.

Args:
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  A list of table names in the public schema.

Example:
  - Use when: "What tables are in my database?"
  - Use when: "Show me the tables in the users database"

Error Handling:
  - Returns an error if the database doesn't exist or connection fails`,
      inputSchema: {
        database: z
          .string()
          .optional()
          .describe('Database name to list tables from (optional, uses DB_NAME env if omitted)'),
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
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
          undefined,
          params.database
        );
        const tables = result.rows.map((r) => r.table_name as string);

        return {
          content: [
            {
              type: 'text',
              text: `Found ${tables.length} table(s):\n\n${tables.map((t) => `- ${t}`).join('\n')}`,
            },
          ],
          structuredContent: { tables, database: params.database || process.env.DB_NAME },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing tables: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
