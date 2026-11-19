import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';
import { mapRelationships, relationshipsQuery } from '../catalog.js';

export function registerListRelationships(server: McpServer): void {
  server.registerTool(
    'postgres_list_relationships',
    {
      title: 'List PostgreSQL Table Relationships',
      description: `Discover foreign key relationships between tables in a database.

Use this tool to understand how tables are related before writing JOIN queries.
Returns all foreign key constraints showing which columns in which tables reference other tables.
Composite foreign keys are returned one row per column pair.

Args:
  - table_name (string, optional): Filter relationships for a specific table. Use table or schema.table.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  A list of foreign key relationships with source/target schemas, tables, and columns.

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
      outputSchema: {
        relationships: z.array(
          z.object({
            constraint_name: z.string(),
            source_schema: z.string(),
            source_table: z.string(),
            source_column: z.string(),
            target_schema: z.string(),
            target_table: z.string(),
            target_column: z.string(),
          })
        ),
        count: z.number(),
        database: z.string().optional(),
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
        const lookup = relationshipsQuery({ tableName: params.table_name });
        const result = await query(lookup.sql, lookup.params, params.database);

        if (result.rows.length === 0) {
          const message = params.table_name
            ? `No foreign key relationships found for table '${params.table_name}'.`
            : 'No foreign key relationships found in the database.';
          return {
            content: [{ type: 'text', text: message }],
            structuredContent: { relationships: [], count: 0 },
          };
        }

        const relationships = mapRelationships(result.rows);

        const lines: string[] = [];
        lines.push(`Found ${relationships.length} relationship(s):\n`);
        for (const rel of relationships) {
          lines.push(
            `- **${rel.source_schema}.${rel.source_table}.${rel.source_column}** → **${rel.target_schema}.${rel.target_table}.${rel.target_column}** (${rel.constraint_name})`
          );
        }

        lines.push(`\n---`);
        lines.push(`To JOIN these tables, use:`);
        for (const rel of relationships) {
          lines.push(
            `  JOIN ${rel.target_schema}.${rel.target_table} ON ${rel.source_schema}.${rel.source_table}.${rel.source_column} = ${rel.target_schema}.${rel.target_table}.${rel.target_column}`
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
