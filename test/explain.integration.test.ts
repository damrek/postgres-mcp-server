import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeAll, query } from '../src/db.js';
import { registerDescribeTable } from '../src/tools/describe_table.js';
import { registerExplainQuery } from '../src/tools/explain_query.js';
import { registerListDatabases } from '../src/tools/list_databases.js';
import { registerListRelationships } from '../src/tools/list_relationships.js';
import { registerListTables } from '../src/tools/list_tables.js';
import { registerQueryData } from '../src/tools/query_data.js';
import { adminClient, configureTestDb, integrationEnabled } from './test-db.js';

configureTestDb();
const integrationTest = integrationEnabled ? test : test.skip;

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

interface ToolClient {
  client: Client;
  close: () => Promise<void>;
}

async function connectToolClient(): Promise<ToolClient> {
  const server = new McpServer({ name: 'phase4-explain-test', version: '0.0.0' });
  registerExplainQuery(server);
  registerListTables(server);
  registerDescribeTable(server);
  registerListDatabases(server);
  registerQueryData(server);
  registerListRelationships(server);

  const client = new Client({ name: 'phase4-explain-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: ToolResult): string {
  const blocks = result.content;
  if (!Array.isArray(blocks)) {
    assert.fail('expected content blocks');
  }
  const block = blocks[0] as { type?: unknown; text?: unknown } | undefined;
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    assert.fail('expected a text content block');
  }
  return block.text;
}

integrationTest('postgres_explain_query returns JSON plans and rejects writes', async () => {
  const admin = adminClient();
  await admin.connect();
  const tools = await connectToolClient();

  try {
    await admin.query('DROP TABLE IF EXISTS phase4_explain_probe, phase4_explain_created, phase4_explain_into CASCADE');
    await admin.query('CREATE TABLE phase4_explain_probe (id int PRIMARY KEY, label text)');
    await admin.query(
      "INSERT INTO phase4_explain_probe (id, label) VALUES (1, 'a'), (2, 'b')"
    );

    const explained = await tools.client.callTool({
      name: 'postgres_explain_query',
      arguments: { sql: 'SELECT * FROM phase4_explain_probe WHERE id = 1' },
    });
    assert.notEqual(explained.isError, true);
    const explainedContent = explained.structuredContent as
      | { plan: unknown; analyze: boolean }
      | undefined;
    assert.ok(explainedContent);
    assert.equal(explainedContent.analyze, false);
    assert.ok(Array.isArray(explainedContent.plan));
    assert.equal(textOf(explained), JSON.stringify(explainedContent.plan, null, 2));

    const plan = explainedContent.plan as Array<Record<string, unknown>>;
    const planNode = plan[0]?.Plan as Record<string, unknown> | undefined;
    assert.equal(typeof planNode?.['Node Type'], 'string');

    const analyzed = await tools.client.callTool({
      name: 'postgres_explain_query',
      arguments: { sql: 'SELECT * FROM phase4_explain_probe WHERE id = 1', analyze: true },
    });
    assert.notEqual(analyzed.isError, true);
    const analyzedContent = analyzed.structuredContent as
      | { plan: unknown; analyze: boolean }
      | undefined;
    assert.ok(analyzedContent);
    assert.equal(analyzedContent.analyze, true);
    const analyzedPlan = analyzedContent.plan as Array<Record<string, unknown>>;
    assert.equal(typeof analyzedPlan[0]?.['Execution Time'], 'number');
    const analyzedNode = analyzedPlan[0]?.Plan as Record<string, unknown> | undefined;
    assert.equal(typeof analyzedNode?.['Actual Rows'], 'number');

    const rejected = [
      'DELETE FROM phase4_explain_probe',
      'CREATE TABLE phase4_explain_created AS SELECT 1',
      'SELECT * INTO phase4_explain_into FROM phase4_explain_probe',
    ];
    for (const sql of rejected) {
      const rejectedResult = await tools.client.callTool({
        name: 'postgres_explain_query',
        arguments: { sql, analyze: true },
      });
      assert.equal(rejectedResult.isError, true, sql);
      assert.match(textOf(rejectedResult), /^Error: /, sql);
    }

    const created = await query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('phase4_explain_created', 'phase4_explain_into')"
    );
    assert.equal(created.rows.length, 0);

    const intact = await query('SELECT count(*)::int AS count FROM phase4_explain_probe');
    assert.equal(intact.rows[0]?.count, 2);
  } finally {
    await admin.query(
      'DROP TABLE IF EXISTS phase4_explain_probe, phase4_explain_created, phase4_explain_into CASCADE'
    );
    await admin.end();
    await tools.close();
    await closeAll();
  }
});

integrationTest('schema-scoped list_tables and describe_table resolve the requested schema', async () => {
  const admin = adminClient();
  await admin.connect();
  const tools = await connectToolClient();

  try {
    await admin.query('DROP SCHEMA IF EXISTS phase4_catalog_schema CASCADE');
    await admin.query('DROP TABLE IF EXISTS phase4_public_probe CASCADE');
    await admin.query('CREATE SCHEMA phase4_catalog_schema');
    await admin.query('CREATE SCHEMA "Phase4Mixed"');
    await admin.query('CREATE TABLE phase4_public_probe (id int)');
    await admin.query(
      "CREATE TABLE phase4_catalog_schema.phase4_scoped_probe (id int PRIMARY KEY, label text NOT NULL DEFAULT 'scoped')"
    );
    await admin.query('CREATE TABLE "Phase4Mixed".phase4_mixed_probe (id int)');

    const scoped = await tools.client.callTool({
      name: 'postgres_list_tables',
      arguments: { schema: 'phase4_catalog_schema' },
    });
    const scopedContent = scoped.structuredContent as
      | { tables: string[]; schema: string; database?: string }
      | undefined;
    assert.ok(scopedContent);
    assert.deepEqual(scopedContent.tables, ['phase4_scoped_probe']);
    assert.equal(scopedContent.schema, 'phase4_catalog_schema');
    assert.match(textOf(scoped), /- phase4_scoped_probe/);

    const defaultTables = await tools.client.callTool({
      name: 'postgres_list_tables',
      arguments: {},
    });
    const defaultContent = defaultTables.structuredContent as
      | { tables: string[]; schema: string }
      | undefined;
    assert.ok(defaultContent);
    assert.equal(defaultContent.schema, 'public');
    assert.ok(defaultContent.tables.includes('phase4_public_probe'));
    assert.ok(!defaultContent.tables.includes('phase4_scoped_probe'));

    const uppercaseList = await tools.client.callTool({
      name: 'postgres_list_tables',
      arguments: { schema: 'PHASE4_CATALOG_SCHEMA' },
    });
    const uppercaseListContent = uppercaseList.structuredContent as
      | { tables: string[]; schema: string }
      | undefined;
    assert.notEqual(uppercaseList.isError, true);
    assert.equal(uppercaseListContent?.schema, 'phase4_catalog_schema');
    assert.deepEqual(uppercaseListContent?.tables, ['phase4_scoped_probe']);

    const mixedList = await tools.client.callTool({
      name: 'postgres_list_tables',
      arguments: { schema: '"Phase4Mixed"' },
    });
    const mixedListContent = mixedList.structuredContent as
      | { tables: string[]; schema: string }
      | undefined;
    assert.notEqual(mixedList.isError, true);
    assert.equal(mixedListContent?.schema, 'Phase4Mixed');
    assert.deepEqual(mixedListContent?.tables, ['phase4_mixed_probe']);

    const missingSchemaList = await tools.client.callTool({
      name: 'postgres_list_tables',
      arguments: { schema: 'phase4_missing_schema' },
    });
    assert.equal(missingSchemaList.isError, true);
    assert.equal(textOf(missingSchemaList), "Error: Schema 'phase4_missing_schema' does not exist.");

    const described = await tools.client.callTool({
      name: 'postgres_describe_table',
      arguments: { table_name: 'phase4_scoped_probe', schema: 'phase4_catalog_schema' },
    });
    assert.notEqual(described.isError, true);
    const describedContent = described.structuredContent as
      | {
          table: string;
          schema: string;
          columns: Array<{ name: string; nullable: boolean; default: string | null }>;
          constraints: Array<{ type: string; name: string }>;
          indexes: Array<{ name: string; definition: string }>;
        }
      | undefined;
    assert.ok(describedContent);
    assert.equal(describedContent.table, 'phase4_scoped_probe');
    assert.equal(describedContent.schema, 'phase4_catalog_schema');
    assert.deepEqual(
      describedContent.columns.map((column) => column.name),
      ['id', 'label']
    );
    assert.equal(describedContent.columns[1]?.nullable, false);
    assert.match(describedContent.columns[1]?.default ?? '', /'scoped'/);
    assert.ok(describedContent.constraints.some((constraint) => constraint.type === 'PRIMARY KEY'));
    assert.ok(describedContent.indexes.length >= 1);

    const missing = await tools.client.callTool({
      name: 'postgres_describe_table',
      arguments: { table_name: 'phase4_scoped_probe' },
    });
    assert.notEqual(missing.isError, true);
    assert.equal(
      textOf(missing),
      "No columns found for table 'public.phase4_scoped_probe'. Table may not exist."
    );
    const missingContent = missing.structuredContent as { columns: unknown[] } | undefined;
    assert.equal(missingContent?.columns.length, 0);

    const uppercaseDescribe = await tools.client.callTool({
      name: 'postgres_describe_table',
      arguments: { table_name: 'phase4_scoped_probe', schema: 'PHASE4_CATALOG_SCHEMA' },
    });
    assert.notEqual(uppercaseDescribe.isError, true);
    assert.equal(
      (uppercaseDescribe.structuredContent as { schema: string } | undefined)?.schema,
      'phase4_catalog_schema'
    );
    assert.match(textOf(uppercaseDescribe), /Table: phase4_scoped_probe/);

    const mixedDescribe = await tools.client.callTool({
      name: 'postgres_describe_table',
      arguments: { table_name: 'phase4_mixed_probe', schema: '"Phase4Mixed"' },
    });
    assert.notEqual(mixedDescribe.isError, true);
    assert.equal(
      (mixedDescribe.structuredContent as { schema: string } | undefined)?.schema,
      'Phase4Mixed'
    );

    const missingSchemaDescribe = await tools.client.callTool({
      name: 'postgres_describe_table',
      arguments: { table_name: 'phase4_scoped_probe', schema: 'phase4_missing_schema' },
    });
    assert.equal(missingSchemaDescribe.isError, true);
    assert.equal(
      textOf(missingSchemaDescribe),
      "Error: Schema 'phase4_missing_schema' does not exist."
    );
  } finally {
    await admin.query('DROP SCHEMA IF EXISTS phase4_catalog_schema CASCADE');
    await admin.query('DROP SCHEMA IF EXISTS "Phase4Mixed" CASCADE');
    await admin.query('DROP TABLE IF EXISTS phase4_public_probe CASCADE');
    await admin.end();
    await tools.close();
    await closeAll();
  }
});

integrationTest('live structured content validates against every output schema', async () => {
  const tools = await connectToolClient();

  try {
    const databases = await tools.client.callTool({
      name: 'postgres_list_databases',
      arguments: {},
    });
    assert.notEqual(databases.isError, true);
    const databasesContent = databases.structuredContent as { databases: string[] } | undefined;
    assert.ok(Array.isArray(databasesContent?.databases));
    assert.ok(databasesContent?.databases.includes(process.env.DB_NAME ?? ''));

    const queried = await tools.client.callTool({
      name: 'postgres_query_data',
      arguments: { sql: 'SELECT 1 AS value' },
    });
    assert.notEqual(queried.isError, true);
    assert.deepEqual(queried.structuredContent, {
      rows: [{ value: 1 }],
      count: 1,
      fields: ['value'],
      truncated: false,
    });

    const relationships = await tools.client.callTool({
      name: 'postgres_list_relationships',
      arguments: {},
    });
    assert.notEqual(relationships.isError, true);
    const relationshipsContent = relationships.structuredContent as
      | { relationships: unknown[]; count: number }
      | undefined;
    assert.ok(Array.isArray(relationshipsContent?.relationships));
    assert.equal(relationshipsContent?.count, relationshipsContent?.relationships.length);
  } finally {
    await tools.close();
    await closeAll();
  }
});
