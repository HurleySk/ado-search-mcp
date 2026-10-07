# ado-search-mcp

MCP server that wraps the [ado-search](https://github.com/HurleySk/ado-search) CLI for Azure DevOps work item search and management.

## Tools

| Tool | Description |
|---|---|
| `ado_search` | Full-text search of indexed work items and wiki pages |
| `ado_grep` | Regex pattern search across work item fields |
| `ado_children` | List children/descendants of a work item |
| `ado_show` | Show full content of a work item or wiki page |
| `ado_list_links` | List links on a work item (live from ADO) |
| `ado_list_comments` | List comments on a work item (live from ADO) |
| `ado_fetch` | Fetch specific work items by ID into local store |
| `ado_create` | Create a new work item |
| `ado_update` | Update an existing work item |
| `ado_add_comment` | Add a comment to a work item |
| `ado_add_link` | Add a link between two work items |
| `ado_remove_link` | Remove a link between two work items |

`ado_search` and `ado_grep` accept an optional `project` filter for data dirs that sync several projects (ado-search >= 1.14).

`ado_add_comment` turns `@Display Name` and `@email` tags into ADO mentions and refuses to post when a tag is unknown or names several people (ado-search >= 1.15). A tag may start the comment. Write `&#64;` for a literal `@`, or pass `resolve_mentions: false` to post the text as-is. HTML values (comment text, description, acceptance criteria) reach the CLI through a temp file, so text starting with `@` or `-` is safe.

## Prerequisites

- Node.js 18+
- [ado-search](https://github.com/HurleySk/ado-search) CLI installed and on PATH
- An initialized ado-search data directory (`ado-search init && ado-search sync`)

## Setup

1. Clone and build:

```bash
git clone https://github.com/HurleySk/ado-search-mcp.git
cd ado-search-mcp
npm install
npm run build
```

2. Create a config file (`ado-search-mcp.json`):

```json
{
  "dataDir": "/path/to/your/ado-search/data-dir",
  "adoSearchPath": "ado-search"
}
```

3. Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ado-search": {
      "command": "node",
      "args": ["/path/to/ado-search-mcp/dist/server.js"],
      "env": {
        "ADO_SEARCH_CONFIG": "/path/to/ado-search-mcp.json"
      }
    }
  }
}
```

## Configuration

The server looks for config in this order:

1. `ADO_SEARCH_CONFIG` environment variable (path to JSON config file)
2. `ado-search-mcp.json` sidecar file next to `dist/server.js`
3. `ADO_DATA_DIR` environment variable (data directory path only)

## License

MIT
