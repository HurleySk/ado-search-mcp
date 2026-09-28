import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdoSearchConfig } from "./config.js";
import { runAdoSearch, parseJsonOutput, toMcpResult, toMcpText, toMcpError } from "./cli.js";

function addOptionalFilters(
  args: string[],
  params: {
    type_filter?: string;
    state_filter?: string;
    area_filter?: string;
    assigned_to?: string;
    tag_filter?: string;
    project?: string;
  },
): void {
  if (params.type_filter) args.push("--type", params.type_filter);
  if (params.state_filter) args.push("--state", params.state_filter);
  if (params.area_filter) args.push("--area", params.area_filter);
  if (params.assigned_to) args.push("--assigned-to", params.assigned_to);
  if (params.tag_filter) args.push("--tag", params.tag_filter);
  if (params.project) args.push("--project", params.project);
}

const FILTER_SCHEMAS = {
  type_filter: z.string().optional().describe("Filter by work item type (e.g. 'Bug', 'User Story')"),
  state_filter: z.string().optional().describe("Filter by state (e.g. 'Active', 'Closed')"),
  area_filter: z.string().optional().describe("Filter by area path (prefix match)"),
  assigned_to: z.string().optional().describe("Filter by assignee email"),
  tag_filter: z.string().optional().describe("Filter by tag"),
  project: z.string().optional().describe("Filter by Azure DevOps project name (requires ado-search >= 1.14)"),
};

export function registerTools(server: McpServer, config: AdoSearchConfig): void {
  // ── Tier 1: Local Read ──

  server.tool(
    "ado_search",
    "Full-text search of indexed Azure DevOps work items and wiki pages",
    {
      query: z.string().min(1).describe("Search query text"),
      ...FILTER_SCHEMAS,
      limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
    },
    async (params) => {
      const args = ["search", params.query, "--format", "json", "--limit", String(params.limit)];
      addOptionalFilters(args, params);
      try {
        const result = await runAdoSearch(config, args);
        return toMcpResult(parseJsonOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_grep",
    "Regex pattern search across work item fields (title, description, comments, etc.)",
    {
      pattern: z.string().min(1).describe("Regex pattern to search for"),
      fields: z
        .array(
          z.enum([
            "title",
            "description",
            "acceptance_criteria",
            "comments",
            "tags",
            "assigned_to",
            "area",
            "iteration",
            "state_history",
          ]),
        )
        .optional()
        .describe("Fields to search (default: title, description, comments)"),
      ...FILTER_SCHEMAS,
      ignore_case: z.boolean().default(true).describe("Case-insensitive matching"),
      context_chars: z.number().int().default(60).describe("Characters of context around each match"),
      limit: z.number().int().min(1).max(200).default(50).describe("Max results"),
    },
    async (params) => {
      const args = ["grep", params.pattern, "--format", "json", "--limit", String(params.limit)];
      if (params.ignore_case) args.push("-i");
      args.push("-C", String(params.context_chars));
      if (params.fields) {
        for (const f of params.fields) args.push("--field", f);
      }
      addOptionalFilters(args, params);
      try {
        const result = await runAdoSearch(config, args);
        return toMcpResult(parseJsonOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_children",
    "List children or descendants of a work item by parent ID",
    {
      parent_id: z.number().int().describe("Parent work item ID"),
      recursive: z.boolean().default(false).describe("Show all descendants, not just direct children"),
      type_filter: FILTER_SCHEMAS.type_filter,
      state_filter: FILTER_SCHEMAS.state_filter,
      include_closed_date: z.boolean().default(false).describe("Include closed date from state history"),
    },
    async (params) => {
      const args = ["children", String(params.parent_id), "--format", "json"];
      if (params.recursive) args.push("--recursive");
      if (params.include_closed_date) args.push("--include-closed-date");
      if (params.type_filter) args.push("--type", params.type_filter);
      if (params.state_filter) args.push("--state", params.state_filter);
      try {
        const result = await runAdoSearch(config, args);
        return toMcpResult(parseJsonOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_show",
    "Show full content of a work item (by numeric ID) or wiki page (by path). Returns formatted markdown.",
    {
      item_id: z.string().describe("Work item ID (number) or wiki page path"),
    },
    async (params) => {
      try {
        const result = await runAdoSearch(config, ["show", params.item_id]);
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  // ── Tier 2: Live Read ──

  server.tool(
    "ado_list_links",
    "List links on a work item (fetched live from Azure DevOps)",
    {
      work_item_id: z.number().int().describe("Work item ID"),
    },
    async (params) => {
      try {
        const result = await runAdoSearch(config, ["list-links", String(params.work_item_id)], {
          timeout: 120_000,
        });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_list_comments",
    "List comments on a work item (fetched live from Azure DevOps)",
    {
      work_item_id: z.number().int().describe("Work item ID"),
    },
    async (params) => {
      try {
        const result = await runAdoSearch(config, ["list-comments", String(params.work_item_id)], {
          timeout: 120_000,
        });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_fetch",
    "Fetch specific work items by ID from Azure DevOps and add to local store",
    {
      ids: z.array(z.number().int()).min(1).describe("Work item IDs to fetch"),
      include_attachments: z.boolean().default(false).describe("Download attachments"),
      include_comments: z.boolean().default(false).describe("Fetch comments"),
    },
    async (params) => {
      const args = ["fetch", ...params.ids.map(String)];
      if (params.include_attachments) args.push("--include-attachments");
      if (params.include_comments) args.push("--include-comments");
      try {
        const result = await runAdoSearch(config, args, { timeout: 120_000 });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  // ── Tier 3: Write ──

  server.tool(
    "ado_create",
    "Create a new work item in Azure DevOps",
    {
      type: z.string().describe("Work item type (Bug, User Story, Task, Epic, Feature)"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Description (HTML)"),
      acceptance_criteria: z.string().optional().describe("Acceptance criteria (HTML)"),
      state: z.string().optional().describe("Initial state"),
      reason: z.string().optional().describe("Reason (e.g. for closing)"),
      area: z.string().optional().describe("Area path"),
      iteration: z.string().optional().describe("Iteration path"),
      assigned_to: z.string().optional().describe("Assignee email or display name"),
      tags: z.string().optional().describe("Semicolon-separated tags"),
      priority: z.number().int().min(1).max(4).optional().describe("Priority (1=highest)"),
      story_points: z.number().optional().describe("Story points"),
      parent: z.number().int().optional().describe("Parent work item ID"),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional ADO fields as key-value pairs"),
    },
    async (params) => {
      const args = ["create", "--type", params.type, "--title", params.title];
      if (params.description) args.push("--description", params.description);
      if (params.acceptance_criteria) args.push("--acceptance-criteria", params.acceptance_criteria);
      if (params.state) args.push("--state", params.state);
      if (params.reason) args.push("--reason", params.reason);
      if (params.area) args.push("--area", params.area);
      if (params.iteration) args.push("--iteration", params.iteration);
      if (params.assigned_to) args.push("--assigned-to", params.assigned_to);
      if (params.tags) args.push("--tags", params.tags);
      if (params.priority != null) args.push("--priority", String(params.priority));
      if (params.story_points != null) args.push("--story-points", String(params.story_points));
      if (params.parent != null) args.push("--parent", String(params.parent));
      if (params.fields) {
        for (const [key, value] of Object.entries(params.fields)) {
          args.push("--field", `${key}=${value}`);
        }
      }
      try {
        const result = await runAdoSearch(config, args, { timeout: 120_000 });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_update",
    "Update an existing work item in Azure DevOps",
    {
      work_item_id: z.number().int().describe("Work item ID to update"),
      title: z.string().optional().describe("New title"),
      state: z.string().optional().describe("New state"),
      reason: z.string().optional().describe("Reason (e.g. for closing)"),
      description: z.string().optional().describe("New description (HTML)"),
      acceptance_criteria: z.string().optional().describe("New acceptance criteria (HTML)"),
      area: z.string().optional().describe("New area path"),
      iteration: z.string().optional().describe("New iteration path"),
      assigned_to: z.string().optional().describe("New assignee email or display name"),
      tags: z.string().optional().describe("Semicolon-separated tags"),
      priority: z.number().int().min(1).max(4).optional().describe("Priority (1=highest)"),
      story_points: z.number().optional().describe("Story points"),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional ADO fields as key-value pairs"),
    },
    async (params) => {
      const args = ["update", String(params.work_item_id)];
      if (params.title) args.push("--title", params.title);
      if (params.state) args.push("--state", params.state);
      if (params.reason) args.push("--reason", params.reason);
      if (params.description) args.push("--description", params.description);
      if (params.acceptance_criteria) args.push("--acceptance-criteria", params.acceptance_criteria);
      if (params.area) args.push("--area", params.area);
      if (params.iteration) args.push("--iteration", params.iteration);
      if (params.assigned_to) args.push("--assigned-to", params.assigned_to);
      if (params.tags) args.push("--tags", params.tags);
      if (params.priority != null) args.push("--priority", String(params.priority));
      if (params.story_points != null) args.push("--story-points", String(params.story_points));
      if (params.fields) {
        for (const [key, value] of Object.entries(params.fields)) {
          args.push("--field", `${key}=${value}`);
        }
      }
      try {
        const result = await runAdoSearch(config, args, { timeout: 120_000 });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_add_comment",
    "Add a comment to a work item",
    {
      work_item_id: z.number().int().describe("Work item ID"),
      text: z.string().min(1).describe("Comment text (HTML supported)"),
    },
    async (params) => {
      try {
        const result = await runAdoSearch(
          config,
          ["add-comment", String(params.work_item_id), params.text],
          { timeout: 120_000 },
        );
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_add_link",
    "Add a link between two work items",
    {
      source_id: z.number().int().describe("Source work item ID"),
      target_id: z.number().int().describe("Target work item ID"),
      link_type: z
        .string()
        .describe("Link type: related, parent, child, duplicate, duplicate-of, depends-on, predecessor, successor"),
      comment: z.string().optional().describe("Optional comment on the link"),
    },
    async (params) => {
      const args = [
        "add-link",
        String(params.source_id),
        String(params.target_id),
        "--type",
        params.link_type,
      ];
      if (params.comment) args.push("--comment", params.comment);
      try {
        const result = await runAdoSearch(config, args, { timeout: 120_000 });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_remove_link",
    "Remove a link between two work items",
    {
      source_id: z.number().int().describe("Source work item ID"),
      target_id: z.number().int().describe("Target work item ID"),
      link_type: z
        .string()
        .describe("Link type: related, parent, child, duplicate, duplicate-of, depends-on, predecessor, successor"),
    },
    async (params) => {
      try {
        const result = await runAdoSearch(
          config,
          [
            "remove-link",
            String(params.source_id),
            String(params.target_id),
            "--type",
            params.link_type,
          ],
          { timeout: 120_000 },
        );
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(result.stdout);
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );
}
