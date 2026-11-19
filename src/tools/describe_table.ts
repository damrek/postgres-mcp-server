import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';
import {
  columnsQuery,
  constraintsQuery,
  indexesQuery,
  mapConstraints,
  mapIndexes,
  PUBLIC_SCHEMA,
  resolveSchemaName,
} from '../catalog.js';

export function registerDescribeTable(server: McpServer): void {
  server.registerTool(
    'postgres_describe_table',
    {
      title: 'Describe PostgreSQL Table',
      description: `Get the structure of a table including columns, constraints, and indexes.

Args:
  - table_name (string): Name of the table to describe.
  - schema (string, optional): Schema that contains the table (default: public). Unquoted names fold to lowercase; double-quote mixed-case names.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  - Column details: name, data type, nullable, default value.
  - Constraints: primary keys, unique, check, and foreign key constraints with their definitions.
  - Indexes: all indexes defined on the table.

Example:
  - Use when: "What columns does the users table have?"
  - Use when: "Show me the structure of the orders table"
  - Use when: "What indexes are on the users table?"
  - Use when: "Describe analytics.events" -> table_name="events", schema="analytics"

Error Handling:
  - Returns text noting the table may not exist when no columns are found`,
      inputSchema: {
        table_name: z.string().describe('Name of the table to describe'),
        schema: z
          .string()
          .min(1)
          .default(PUBLIC_SCHEMA)
          .describe(
            'Schema that contains the table (default: public; unquoted names fold to lowercase, double-quote mixed-case names)'
          ),
        database: z
          .string()
          .optional()
          .describe('Database name (optional, uses DB_NAME env if omitted)'),
      },
      outputSchema: {
        table: z.string(),
        schema: z.string(),
        columns: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            nullable: z.boolean(),
            default: z.string().nullable(),
          })
        ),
        constraints: z.array(
          z.object({
            type: z.string(),
            name: z.string(),
            columns: z.array(z.string()).optional(),
            check_clause: z.string().optional(),
            definition: z.string().optional(),
          })
        ),
        indexes: z.array(
          z.object({
            name: z.string(),
            definition: z.string(),
          })
        ),
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
        const schema = await resolveSchemaName(params.schema, params.database);
        if (!schema) {
          return {
            content: [{ type: 'text', text: `Error: Schema '${params.schema}' does not exist.` }],
            isError: true,
          };
        }

        const columnLookup = columnsQuery(params.table_name, schema);
        const constraintLookup = constraintsQuery(params.table_name, schema);
        const indexLookup = indexesQuery(params.table_name, schema);

        const [columnsResult, constraintsResult, indexesResult] = await Promise.all([
          query(columnLookup.sql, columnLookup.params, params.database),
          query(constraintLookup.sql, constraintLookup.params, params.database),
          query(indexLookup.sql, indexLookup.params, params.database),
        ]);

        if (columnsResult.rows.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No columns found for table '${schema}.${params.table_name}'. Table may not exist.`,
              },
            ],
            structuredContent: {
              table: params.table_name,
              schema,
              columns: [],
              constraints: [],
              indexes: [],
            },
          };
        }

        const columns = columnsResult.rows.map((r) => ({
          name: r.column_name as string,
          type: r.data_type as string,
          nullable: (r.is_nullable as string) === 'YES',
          default: r.column_default as string | null,
        }));

        const constraints = mapConstraints(constraintsResult.rows);
        const indexes = mapIndexes(indexesResult.rows);

        const lines = [`## Table: ${params.table_name}\n`];

        lines.push('### Columns\n');
        for (const col of columns) {
          lines.push(`- **${col.name}**: ${col.type}${col.nullable ? ' (nullable)' : ' (not null)'}`);
          if (col.default) lines.push(`  Default: ${col.default}`);
        }

        if (constraints.length > 0) {
          lines.push('\n### Constraints\n');
          for (const constraint of constraints) {
            const columns = constraint.columns?.join(', ');
            if (constraint.type === 'CHECK' || constraint.type === 'FOREIGN KEY') {
              lines.push(`- **${constraint.type}** ${constraint.name}: ${constraint.definition ?? ''}`);
            } else {
              lines.push(`- **${constraint.type}** ${constraint.name}: (${columns})`);
            }
          }
        }

        if (indexes.length > 0) {
          lines.push('\n### Indexes\n');
          for (const index of indexes) {
            lines.push(`- **${index.name}**: ${index.definition}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            table: params.table_name,
            schema,
            columns,
            constraints,
            indexes,
          },
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
