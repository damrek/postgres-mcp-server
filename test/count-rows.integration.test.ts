import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeAll } from '../src/db.js';
import { registerCountRows } from '../src/tools/count_rows.js';
import { adminClient, configureTestDb, integrationEnabled } from './test-db.js';

configureTestDb();
const integrationTest = integrationEnabled ? test : test.skip;

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

interface ToolClient {
  client: Client;
  close: () => Promise<void>;
}

async function connectToolClient(): Promise<ToolClient> {
  const server = new McpServer({ name: 'phase4-count-test', version: '0.0.0' });
  registerCountRows(server);

  const client = new Client({ name: 'phase4-count-client', version: '0.0.0' });
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

interface CountContent {
  table: string;
  schema: string;
  count: number;
  estimated: boolean;
  where_clause: string | null;
}

integrationTest('postgres_count_rows supports exact and estimated counts', async () => {
  const admin = adminClient();
  await admin.connect();
  const tools = await connectToolClient();

  try {
    await admin.query('DROP SCHEMA IF EXISTS phase4_count_schema CASCADE');
    await admin.query(
      'DROP TABLE IF EXISTS phase4_count_probe, phase4_count_unanalyzed CASCADE'
    );
    await admin.query('CREATE TABLE phase4_count_probe (id int PRIMARY KEY, status text)');
    await admin.query(
      "INSERT INTO phase4_count_probe (id, status) VALUES (1, 'active'), (2, 'active'), (3, 'inactive')"
    );
    await admin.query('ANALYZE phase4_count_probe');

    const exact = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_probe' },
    });
    assert.notEqual(exact.isError, true);
    assert.deepEqual(exact.structuredContent, {
      table: 'phase4_count_probe',
      schema: 'public',
      count: 3,
      estimated: false,
      where_clause: null,
    });
    assert.equal(textOf(exact), "Table 'phase4_count_probe' has 3 row(s) total");

    const filtered = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_probe', where_clause: "status = 'active'" },
    });
    const filteredContent = filtered.structuredContent as CountContent | undefined;
    assert.equal(filteredContent?.count, 2);
    assert.equal(filteredContent?.estimated, false);
    assert.equal(filteredContent?.where_clause, "status = 'active'");

    const estimate = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_probe', exact: false },
    });
    assert.notEqual(estimate.isError, true);
    assert.deepEqual(estimate.structuredContent, {
      table: 'phase4_count_probe',
      schema: 'public',
      count: 3,
      estimated: true,
      where_clause: null,
    });
    assert.equal(
      textOf(estimate),
      "Table 'public.phase4_count_probe' has approximately 3 row(s) (estimate)."
    );

    await admin.query('CREATE SCHEMA phase4_count_schema');
    await admin.query('CREATE TABLE phase4_count_schema.phase4_count_probe (id int)');
    await admin.query('INSERT INTO phase4_count_schema.phase4_count_probe (id) VALUES (1), (2)');
    await admin.query('ANALYZE phase4_count_schema.phase4_count_probe');

    const qualified = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_schema.phase4_count_probe', exact: false },
    });
    const qualifiedContent = qualified.structuredContent as CountContent | undefined;
    assert.equal(qualifiedContent?.schema, 'phase4_count_schema');
    assert.equal(qualifiedContent?.table, 'phase4_count_schema.phase4_count_probe');
    assert.equal(qualifiedContent?.count, 2);
    assert.equal(
      textOf(qualified),
      "Table 'phase4_count_schema.phase4_count_probe' has approximately 2 row(s) (estimate)."
    );

    const unsupported = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_probe', exact: false, where_clause: 'id > 0' },
    });
    assert.equal(unsupported.isError, true);
    assert.equal(textOf(unsupported), 'Error: exact=false does not support where_clause.');

    const emptyWhere = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_probe', exact: false, where_clause: '' },
    });
    assert.equal(emptyWhere.isError, true);
    assert.equal(textOf(emptyWhere), 'Error: exact=false does not support where_clause.');

    const uppercase = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'PHASE4_COUNT_PROBE', exact: false },
    });
    const uppercaseContent = uppercase.structuredContent as CountContent | undefined;
    assert.notEqual(uppercase.isError, true);
    assert.equal(uppercaseContent?.count, 3);
    assert.equal(uppercaseContent?.table, 'PHASE4_COUNT_PROBE');
    assert.equal(uppercaseContent?.schema, 'public');

    const missing = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_missing_probe', exact: false },
    });
    assert.equal(missing.isError, true);
    assert.equal(textOf(missing), "Error: Table 'public.phase4_missing_probe' not found.");

    await admin.query('CREATE TABLE phase4_count_unanalyzed (id int)');
    const negative = await tools.client.callTool({
      name: 'postgres_count_rows',
      arguments: { table_name: 'phase4_count_unanalyzed', exact: false },
    });
    assert.equal(negative.isError, true);
    assert.equal(
      textOf(negative),
      "Row count estimate is not available for 'public.phase4_count_unanalyzed'. Run ANALYZE and retry."
    );
  } finally {
    await admin.query('DROP SCHEMA IF EXISTS phase4_count_schema CASCADE');
    await admin.query(
      'DROP TABLE IF EXISTS phase4_count_probe, phase4_count_unanalyzed CASCADE'
    );
    await admin.end();
    await tools.close();
    await closeAll();
  }
});
