# postgres-mcp-server

MCP server for PostgreSQL database queries via Model Context Protocol.

## Features

- **Read-only access** - Every query runs inside a read-only PostgreSQL transaction; destructive operations are rejected by the database
- **SQL validation** - Single read-only statements only; data-modifying CTEs, locking clauses, and statement stacking are rejected before execution
- **6 built-in tools** - List databases, tables, describe structures, query data, count rows, discover relationships
- **Multiple databases** - Connect to different databases from a single server instance
- **Relationship discovery** - Automatically find foreign keys between tables
- **Parameterized queries** - Use `$1`, `$2` parameters in `postgres_query_data` to keep values out of the SQL text
- **Smart truncation** - `postgres_query_data` responses are limited to 25K characters to prevent token overflow

## Prerequisites

- Node.js >= 18
- PostgreSQL instance accessible

## Installation

```bash
git clone <repo-url>
cd postgres-mcp-server
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | - | Password (optional) |
| `DB_NAME` | - | Default database |
| `DB_STATEMENT_TIMEOUT` | `15000` | Per-statement timeout in milliseconds |
| `DB_CONNECT_TIMEOUT` | `10000` | Connection timeout in milliseconds |

## Usage

### With Claude Desktop

Add to `claude_desktop_config.json`:

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

### With Cursor

Create `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global config):

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

Restart Cursor. A green dot next to the server name in **Settings > MCP** indicates a successful connection.

### With other MCP clients

Run directly:

```bash
DB_HOST=localhost DB_USER=postgres node dist/index.js
```

## Testing

You can test the server using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector \
  -e DB_HOST=localhost \
  -e DB_PORT=5432 \
  -e DB_USER=postgres \
  -e DB_PASSWORD=your_password \
  node /path/to/postgres-mcp-server/dist/index.js
```

This opens a web interface where you can interact with all available tools.

## Available Tools

### postgres_list_databases

Lists all available databases on the PostgreSQL instance.

### postgres_list_tables

Lists all tables in the public schema of a database.

### postgres_describe_table

Shows table structure including columns, constraints (PRIMARY KEY, UNIQUE, CHECK), and indexes.

### postgres_query_data

Executes read-only SELECT queries with optional parameters.

**Parameters:**
- `sql` (required) - SELECT query to execute
- `params` (optional) - Array of values for parameterized queries ($1, $2...)
- `database` (optional) - Database name
- `limit` (optional) - Max rows to return (default: 100, max: 1000)

### postgres_count_rows

Counts rows in a table with optional WHERE clause filtering.

### postgres_list_relationships

Discovers foreign key relationships between tables and suggests JOIN queries.

## Development

```bash
npm run dev       # Start with hot reload
npm run build     # Compile TypeScript
npm run clean     # Remove dist folder
npm test          # Run unit tests
npm run typecheck # Type-check source and tests
```

## Security

Read-only access is enforced in layers, not only by inspecting SQL text:

- **Server-side read-only transactions** - Every query runs inside `BEGIN TRANSACTION READ ONLY`, so PostgreSQL rejects writes even if a statement bypasses client-side validation.
- **Statement validation** - `postgres_query_data` accepts a single read-only statement (`SELECT`, `WITH`, `TABLE`, `VALUES`, `SHOW`, `EXPLAIN`) and rejects data-modifying CTEs, `EXPLAIN ANALYZE` writes, locking clauses, and stacked statements before execution.
- **Identifier validation** - `postgres_count_rows` validates table names and rejects statement separators in `WHERE` clauses.
- **Timeouts** - `statement_timeout` (15s by default) and connection timeouts keep a slow query from blocking the server.
- **Parameterized queries** - Pass values through `$1`, `$2` instead of interpolating them into SQL.

For a hard guarantee, connect with a dedicated role that only has read privileges:

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD 'change_me';
GRANT CONNECT ON DATABASE your_database TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader;
```

## License

MIT
