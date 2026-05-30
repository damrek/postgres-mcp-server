import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';

interface Relationship {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

export function registerListRelationships(server: McpServer): void {
  server.registerTool(
    'postgres_list_relationships',
    {
      title: 'List PostgreSQL Table Relationships',
      description: `Discover foreign key relationships between tables in a database.

Use this tool to understand how tables are related before writing JOIN queries.
Returns all foreign key constraints showing which columns in which tables reference other tables.

Args:
  - table_name (string, optional): Filter relationships for a specific table.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  A list of foreign key relationships with source/target tables and columns.

Example:
  - "What tables are related to the users table?" → table_name="users"
  - "Show me all relationships in the database" → no table_name filter
  - "How do orders connect to customers?" → table_name="orders"`,
      inputSchema: {
        table_name: z
          .string()
          .optional()
          .describe('Filter relationships for a specific table (optional)'),
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
        let sql = `
          SELECT
            tc.constraint_name,
            tc.table_name AS source_table,
            kcu.column_name AS source_column,
            ccu.table_name AS target_table,
            ccu.column_name AS target_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
            AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
        `;

        const queryParams: unknown[] = [];

        if (params.table_name) {
          queryParams.push(params.table_name);
          sql += ` AND (tc.table_name = $${queryParams.length} OR ccu.table_name = $${queryParams.length})`;
        }

        sql += ` ORDER BY tc.table_name, tc.constraint_name`;

        const result = await query(sql, queryParams, params.database);

        if (result.rows.length === 0) {
          const message = params.table_name
            ? `No foreign key relationships found for table '${params.table_name}'.`
            : 'No foreign key relationships found in the database.';
          return {
            content: [{ type: 'text', text: message }],
            structuredContent: { relationships: [], count: 0 },
          };
        }

        const relationships: Relationship[] = result.rows.map((r) => ({
          constraint_name: r.constraint_name as string,
          source_table: r.source_table as string,
          source_column: r.source_column as string,
          target_table: r.target_table as string,
          target_column: r.target_column as string,
        }));

        const lines: string[] = [];
        lines.push(`Found ${relationships.length} relationship(s):\n`);
        for (const rel of relationships) {
          lines.push(
            `- **${rel.source_table}.${rel.source_column}** → **${rel.target_table}.${rel.target_column}** (${rel.constraint_name})`
          );
        }

        lines.push(`\n---`);
        lines.push(`To JOIN these tables, use:`);
        for (const rel of relationships) {
          lines.push(
            `  JOIN ${rel.target_table} ON ${rel.source_table}.${rel.source_column} = ${rel.target_table}.${rel.target_column}`
          );
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            relationships,
            count: relationships.length,
            database: params.database || process.env.DB_NAME,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing relationships: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
