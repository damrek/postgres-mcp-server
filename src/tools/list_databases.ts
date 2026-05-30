import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';

export function registerListDatabases(server: McpServer): void {
  server.registerTool(
    'postgres_list_databases',
    {
      title: 'List PostgreSQL Databases',
      description: `List all available databases in the PostgreSQL instance.

Returns:
  A list of database names available on the server.

Example:
  - Use when: "What databases are available?"
  - Use when: "Show me all the databases"

Error Handling:
  - Returns an error message if the connection fails`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = await query(
          "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
        );
        const databases = result.rows.map((r) => r.datname as string);

        return {
          content: [
            {
              type: 'text',
              text: `Found ${databases.length} database(s):\n\n${databases.map((d) => `- ${d}`).join('\n')}`,
            },
          ],
          structuredContent: { databases },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing databases: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
