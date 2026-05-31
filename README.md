# postgres-mcp-server

MCP server for PostgreSQL database queries via Model Context Protocol.

## Features

- **Read-only access** - All queries are SELECT-only; destructive operations are rejected
- **6 built-in tools** - List databases, tables, describe structures, query data, count rows, discover relationships
- **Multiple databases** - Connect to different databases from a single server instance
- **Relationship discovery** - Automatically find foreign keys between tables
- **Parameterized queries** - Prevents SQL injection with prepared statement support
- **Smart truncation** - Responses are limited to 25K characters to prevent token overflow

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
npm run dev      # Start with hot reload
npm run build    # Compile TypeScript
npm run clean    # Remove dist folder
```

## Security

- All queries are read-only (SELECT only)
- INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE are rejected
- Parameterized queries prevent SQL injection
- Response truncation prevents token overflow

## License

MIT
