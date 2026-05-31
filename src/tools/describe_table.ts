import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';

interface Constraint {
  type: 'PRIMARY KEY' | 'UNIQUE' | 'CHECK' | 'FOREIGN KEY';
  name: string;
  columns?: string[];
  check_clause?: string;
}

interface Index {
  name: string;
  definition: string;
}

export function registerDescribeTable(server: McpServer): void {
  server.registerTool(
    'postgres_describe_table',
    {
      title: 'Describe PostgreSQL Table',
      description: `Get the structure of a table including columns, constraints, and indexes.

Args:
  - table_name (string): Name of the table to describe.
  - database (string, optional): Database name. If omitted, uses DB_NAME env var.

Returns:
  - Column details: name, data type, nullable, default value.
  - Constraints: primary keys, unique, check, and foreign key constraints.
  - Indexes: all indexes defined on the table.

Example:
  - Use when: "What columns does the users table have?"
  - Use when: "Show me the structure of the orders table"
  - Use when: "What indexes are on the users table?"

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
        const [columnsResult, constraintsResult, indexesResult] = await Promise.all([
          query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_name = $1 AND table_schema = 'public'
             ORDER BY ordinal_position`,
            [params.table_name],
            params.database
          ),
          query(
            `SELECT tc.constraint_type, tc.constraint_name, kcu.column_name, cc.check_clause
             FROM information_schema.table_constraints tc
             LEFT JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
             LEFT JOIN information_schema.check_constraints cc
               ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
             WHERE tc.table_name = $1 AND tc.table_schema = 'public'
               AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'CHECK')
             ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position`,
            [params.table_name],
            params.database
          ),
          query(
            `SELECT indexname, indexdef
             FROM pg_indexes
             WHERE tablename = $1 AND schemaname = 'public'`,
            [params.table_name],
            params.database
          ),
        ]);

        if (columnsResult.rows.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No columns found for table '${params.table_name}'. Table may not exist or is not in the public schema.`,
              },
            ],
          };
        }

        const columns = columnsResult.rows.map((r) => ({
          name: r.column_name as string,
          type: r.data_type as string,
          nullable: (r.is_nullable as string) === 'YES',
          default: r.column_default as string | null,
        }));

        const constraintMap = new Map<string, Constraint>();
        for (const r of constraintsResult.rows) {
          const name = r.constraint_name as string;
          const type = r.constraint_type as Constraint['type'];
          if (!constraintMap.has(name)) {
            constraintMap.set(name, {
              type,
              name,
              columns: [],
              check_clause: r.check_clause as string | undefined,
            });
          }
          const constraint = constraintMap.get(name)!;
          if (r.column_name) {
            constraint.columns!.push(r.column_name as string);
          }
        }
        const constraints = Array.from(constraintMap.values());

        const indexes: Index[] = indexesResult.rows.map((r) => ({
          name: r.indexname as string,
          definition: r.indexdef as string,
        }));

        const lines = [`## Table: ${params.table_name}\n`];

        lines.push('### Columns\n');
        for (const col of columns) {
          lines.push(`- **${col.name}**: ${col.type}${col.nullable ? ' (nullable)' : ' (not null)'}`);
          if (col.default) lines.push(`  Default: ${col.default}`);
        }

        if (constraints.length > 0) {
          lines.push('\n### Constraints\n');
          for (const c of constraints) {
            if (c.type === 'CHECK') {
              lines.push(`- **${c.type}** ${c.name}: ${c.check_clause}`);
            } else {
              lines.push(`- **${c.type}** ${c.name}: (${c.columns?.join(', ')})`);
            }
          }
        }

        if (indexes.length > 0) {
          lines.push('\n### Indexes\n');
          for (const idx of indexes) {
            lines.push(`- **${idx.name}**: ${idx.definition}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { table: params.table_name, columns, constraints, indexes },
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
