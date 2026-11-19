import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCountRows } from '../src/tools/count_rows.js';
import { registerDescribeTable } from '../src/tools/describe_table.js';
import { registerExplainQuery } from '../src/tools/explain_query.js';
import { registerListDatabases } from '../src/tools/list_databases.js';
import { registerListRelationships } from '../src/tools/list_relationships.js';
import { registerListTables } from '../src/tools/list_tables.js';
import { registerQueryData } from '../src/tools/query_data.js';

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  default?: unknown;
  minLength?: number;
}

interface ToolListing {
  name: string;
  description?: string;
  inputSchema: JsonSchemaNode;
  outputSchema?: JsonSchemaNode;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const TOOL_NAMES = [
  'postgres_count_rows',
  'postgres_describe_table',
  'postgres_explain_query',
  'postgres_list_databases',
  'postgres_list_relationships',
  'postgres_list_tables',
  'postgres_query_data',
];

const REQUIRED_OUTPUT_FIELDS: Record<string, string[]> = {
  postgres_list_databases: ['databases'],
  postgres_list_tables: ['tables', 'schema'],
  postgres_describe_table: ['table', 'schema', 'columns', 'constraints', 'indexes'],
  postgres_query_data: ['rows', 'count', 'fields', 'truncated'],
  postgres_count_rows: ['table', 'schema', 'count', 'estimated', 'where_clause'],
  postgres_list_relationships: ['relationships', 'count'],
  postgres_explain_query: ['plan', 'analyze'],
};

async function listRegisteredTools(): Promise<ToolListing[]> {
  const server = new McpServer({ name: 'phase4-tools-test', version: '0.0.0' });
  registerListDatabases(server);
  registerListTables(server);
  registerDescribeTable(server);
  registerQueryData(server);
  registerCountRows(server);
  registerListRelationships(server);
  registerExplainQuery(server);

  const client = new Client({ name: 'phase4-tools-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    return listed.tools as unknown as ToolListing[];
  } finally {
    await client.close();
    await server.close();
  }
}

test('serves all seven tools with object output schemas', async () => {
  const tools = await listRegisteredTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort()
  );

  for (const tool of tools) {
    assert.equal(tool.outputSchema?.type, 'object', `${tool.name} must expose an object outputSchema`);
    assert.ok(tool.outputSchema?.properties, `${tool.name} outputSchema must declare properties`);
  }
});

test('output schemas require the fields each tool returns', async () => {
  const tools = await listRegisteredTools();

  for (const tool of tools) {
    const expected = REQUIRED_OUTPUT_FIELDS[tool.name];
    assert.ok(expected, `unexpected tool ${tool.name}`);
    assert.deepEqual(
      [...(tool.outputSchema?.required ?? [])].sort(),
      [...expected].sort(),
      `${tool.name} required output fields`
    );
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    Object.keys(byName.get('postgres_list_tables')?.outputSchema?.properties ?? {}).sort(),
    ['database', 'schema', 'tables']
  );
  assert.deepEqual(
    Object.keys(byName.get('postgres_list_relationships')?.outputSchema?.properties ?? {}).sort(),
    ['count', 'database', 'relationships']
  );
});

test('postgres_explain_query declares its inputs, annotations, and timeout warning', async () => {
  const tools = await listRegisteredTools();
  const explain = tools.find((tool) => tool.name === 'postgres_explain_query');
  assert.ok(explain, 'postgres_explain_query must be registered');

  const properties = explain.inputSchema.properties ?? {};
  assert.deepEqual(Object.keys(properties).sort(), ['analyze', 'database', 'sql']);
  assert.equal(properties.sql?.type, 'string');
  assert.equal(properties.sql?.minLength, 1);
  assert.equal(properties.analyze?.type, 'boolean');
  assert.equal(properties.analyze?.default, false);
  assert.equal(properties.database?.type, 'string');
  assert.deepEqual(explain.inputSchema.required, ['sql']);

  assert.deepEqual(explain.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.match(explain.description ?? '', /statement_timeout/);
  assert.match(explain.description ?? '', /analyze/i);
});
