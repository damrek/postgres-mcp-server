# postgres-mcp-server

Read-only MCP server for PostgreSQL. It gives any [Model Context Protocol](https://modelcontextprotocol.io) client (Claude Desktop, Cursor, or another stdio client) seven tools to inspect schemas, run read-only queries, explain plans, count rows, and discover foreign keys. It works against a local database or through Cloud SQL Proxy. Use it for inspection and debugging, not for migrations or writes.

## Quick start

```bash
git clone https://github.com/damrek/postgres-mcp-server.git
cd postgres-mcp-server
npm ci
npm run build
```

1. Set the database environment variables (see [Configuration](#configuration)).
2. Add the server to your MCP client (see [Connect a client](#connect-a-client)).
3. Verify it with the [MCP Inspector](#manual-testing-with-mcp-inspector) or `npm test`.

## Features

- **Read-only by design** - Every query runs inside `BEGIN TRANSACTION READ ONLY` and passes a statement validator; writes, DDL, locking clauses, `SELECT INTO`, and stacked statements are rejected. See [Security](#security).
- **Seven focused tools** - List databases and tables, describe structures, query data, explain plans, count rows, and discover foreign keys.
- **Parameterized queries** - Pass values through `$1`, `$2` instead of interpolating them into SQL.
- **Structured output** - Every tool publishes an `outputSchema` that matches the `structuredContent` it returns, so clients can validate results programmatically.
- **Composite foreign keys** - Relationship discovery maps each source column to its exact target column, with schema-qualified output.
- **Bounded query responses** - `postgres_query_data` applies row limits and 25K character trimming, and every statement is bounded by `DB_STATEMENT_TIMEOUT`.

## Requirements

- Node.js 20.19+, 22.13+, or 24+ (see `engines` in `package.json`).
- A PostgreSQL instance accessible from this process (tested against PostgreSQL 16).
- Network access from this process to `DB_HOST`/`DB_PORT`.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | - | Password (optional) |
| `DB_NAME` | - | Default database. When omitted, connections use the user's default database. |
| `DB_STATEMENT_TIMEOUT` | `15000` | Per-statement timeout in integer milliseconds |
| `DB_CONNECT_TIMEOUT` | `10000` | Connection timeout in integer milliseconds |

### Cloud SQL Proxy

The server only opens TCP connections to `DB_HOST`/`DB_PORT`. For Cloud SQL, start the proxy locally and point the server at it:

```bash
cloud-sql-proxy --port 5432 project:region:instance
```

Then use `DB_HOST=127.0.0.1` and `DB_PORT=5432`. The proxy owns authentication and TLS; the MCP server does not manage the proxy process.

## Connect a client

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/path/to/postgres-mcp-server/dist/index.js"],
      "env": {
        "DB_HOST": "localhost",
        "DB_PORT": "5432",
        "DB_USER": "postgres",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "your_database"
      }
    }
  }
}
```

### Cursor

Use the same `mcpServers` block in `.cursor/mcp.json` at the project root, or in `~/.cursor/mcp.json` for a global configuration. Restart Cursor; a green dot next to the server name in **Settings > MCP** means the connection succeeded.

### Other MCP clients

The server speaks MCP over stdio. Build it first, then run:

```bash
DB_HOST=localhost DB_USER=postgres node dist/index.js
```

## Tools

| Tool | Use it for | Main inputs |
|------|------------|-------------|
| `postgres_list_databases` | Discover databases | - |
| `postgres_list_tables` | List tables and views in a schema | `schema`, `database` |
| `postgres_describe_table` | Columns, constraints, and indexes | `table_name`, `schema`, `database` |
| `postgres_query_data` | Run one read-only statement | `sql`, `params`, `limit`, `database` |
| `postgres_explain_query` | Inspect a JSON execution plan | `sql`, `analyze`, `database` |
| `postgres_count_rows` | Exact or estimated row counts | `table_name`, `where_clause`, `exact`, `database` |
| `postgres_list_relationships` | Foreign keys and JOIN hints | `table_name`, `database` |

All tools except `postgres_list_databases` accept an optional `database`; when omitted it uses `DB_NAME`, or the user's default database if `DB_NAME` is unset. Every tool publishes an `outputSchema` for its `structuredContent`.

### `postgres_list_databases`

Lists non-template databases on the instance.

### `postgres_list_tables`

Lists tables and views in the requested schema. `schema` defaults to `public`. Unquoted schema names fold to lowercase; double-quote mixed-case names (`"MySchema"`).

### `postgres_describe_table`

Returns columns, constraints (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY with PostgreSQL definitions), and indexes. A missing table returns a non-error message with empty arrays instead of failing the request.

### `postgres_query_data`

Runs one read-only statement: `SELECT`, `WITH`, `TABLE`, `VALUES`, `SHOW`, or `EXPLAIN`. Use `params` for `$1`, `$2` values.

Rows are read with a server-side cursor, so an existing `LIMIT` in the SQL is preserved and the SQL text is never rewritten. `limit` defaults to 100 and caps at 1000. The response reports `truncated: true` when rows were dropped by the row limit or by the 25K character trim.

### `postgres_explain_query`

Returns the execution plan as pretty-printed JSON in the text content and in `structuredContent.plan`. With `analyze: true` the statement actually runs, includes actual runtimes and buffer usage, stays inside a read-only transaction, and is bounded by `DB_STATEMENT_TIMEOUT`. Writes, DDL, `SELECT INTO`, locking clauses, and stacked statements are rejected by the same validator used by `postgres_query_data`.

### `postgres_count_rows`

Counts rows with an optional `where_clause` (without the `WHERE` keyword). `exact` defaults to `true` and runs `COUNT(*)`. With `exact: false` it returns PostgreSQL's `reltuples` estimate from `pg_class`, which is cheap on large tables but requires `ANALYZE` for accuracy; estimates apply to tables and partitioned tables, not views. `exact: false` does not support `where_clause`, and reports when no estimate is available.

### `postgres_list_relationships`

Discovers foreign keys across non-system schemas and suggests JOIN clauses. Composite foreign keys return one row per column pair, and every row includes source and target schemas. Filter with `table_name` (source or target) or `schema.table`.

### Limits and behavior

| Topic | Behavior |
|-------|----------|
| `postgres_query_data` rows | Default 100, maximum 1000; an existing SQL `LIMIT` still applies |
| Response size | Rows are dropped when the JSON payload exceeds 25K characters and `truncated` is set |
| Timeouts | `DB_STATEMENT_TIMEOUT` per statement (15s default) and `DB_CONNECT_TIMEOUT` (10s default) |
| Schema names | Default `public`; unquoted names fold to lowercase, mixed-case names need double quotes |
| Count estimates | Require `ANALYZE`; negative estimates are reported as unavailable |
| Relationships | All non-system schemas; one row per foreign-key column pair |

## Testing

### Automated tests

```bash
npm test
```

Unit tests always run. Integration tests need a disposable PostgreSQL database and skip without it:

```bash
TEST_DB_HOST=127.0.0.1 \
TEST_DB_PORT=5432 \
TEST_DB_USER=postgres \
TEST_DB_PASSWORD=postgres \
TEST_DB_NAME=postgres \
npm test
```

### Manual testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector \
  -e DB_HOST=localhost \
  -e DB_PORT=5432 \
  -e DB_USER=postgres \
  -e DB_PASSWORD=your_password \
  node /path/to/postgres-mcp-server/dist/index.js
```

This opens a web interface where you can call every tool interactively.

## Development

```bash
npm run dev       # Start with hot reload
npm run build     # Compile TypeScript
npm run clean     # Remove dist
npm run lint      # Run ESLint
npm test          # Run unit and integration tests (integration skips without TEST_DB_*)
npm run typecheck # Type-check source and tests
```

## Security

Read-only access is enforced in layers, not only by inspecting SQL text:

- **Server-side read-only transactions** - Every query runs inside `BEGIN TRANSACTION READ ONLY`, so PostgreSQL rejects DML and DDL. One PostgreSQL quirk requires the validator: `EXPLAIN ANALYZE` of a DDL statement can still execute it, so `EXPLAIN` is only accepted when its target is a read-only query.
- **Statement validation** - `postgres_query_data` and `postgres_explain_query` accept a single read-only statement and reject data-modifying CTEs, `EXPLAIN ANALYZE` writes, `SELECT INTO`, locking clauses, and stacked statements before execution.
- **Query boundary check** - The database wrapper validates every statement again before it reaches a connection, so a tool that forgets to validate cannot bypass the statement rules.
- **Identifier validation** - `postgres_count_rows` validates table names and rejects statement separators in `WHERE` clauses.
- **Timeouts** - `statement_timeout` and connection timeouts keep a slow query from blocking the server.
- **No network listener** - The server speaks MCP over stdio only; it does not open an HTTP port.
- **Parameterized queries** - Pass values through `$1`, `$2` instead of interpolating them into SQL.

For a hard guarantee, connect with a dedicated role that only has read privileges:

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD 'change_me';
GRANT CONNECT ON DATABASE your_database TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader;
```

Repeat the `USAGE`/`SELECT` grants for every schema you want to expose.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `ECONNREFUSED` | Database or proxy not listening | Start PostgreSQL/Cloud SQL Proxy and check `DB_HOST`/`DB_PORT` |
| `password authentication failed` | Wrong credentials | Check `DB_USER`/`DB_PASSWORD` |
| `permission denied for schema` or `table` | Role lacks grants | Grant `USAGE` on the schema and `SELECT` on the tables |
| `Schema '<name>' does not exist` | Spelling or case mismatch | Use `public`, or double-quote a mixed-case schema |
| `canceling statement due to statement timeout` | Query exceeds 15s | Optimize the query or raise `DB_STATEMENT_TIMEOUT` |
| `No columns found for table ...` | Wrong table or schema | Check the name with `postgres_list_tables` |
| `Row count estimate is not available` | Table was never analyzed | Run `ANALYZE <table>` and retry |

## License

MIT. See [LICENSE](LICENSE).
