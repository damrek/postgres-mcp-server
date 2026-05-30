#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerListDatabases } from './tools/list_databases.js';
import { registerListTables } from './tools/list_tables.js';
import { registerDescribeTable } from './tools/describe_table.js';
import { registerQueryData } from './tools/query_data.js';
import { registerCountRows } from './tools/count_rows.js';
import { registerListRelationships } from './tools/list_relationships.js';
import { closeAll } from './db.js';

const server = new McpServer({
  name: 'postgres-mcp-server',
  version: '1.0.0',
});

registerListDatabases(server);
registerListTables(server);
registerDescribeTable(server);
registerQueryData(server);
registerCountRows(server);
registerListRelationships(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('postgres-mcp-server running via stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  closeAll();
  process.exit(1);
});

process.on('SIGINT', async () => {
  await closeAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeAll();
  process.exit(0);
});
