import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdoSearchConfig } from "./config.js";
import { runAdoSearch, parseJsonOutput, cliOutput, toMcpResult, toMcpText, toMcpError } from "./cli.js";

/**
 * Hands HTML values to the CLI as @file references, so text that starts with
 * "@" (a mention) or "-" is never read as a file path or an option, and long
 * HTML stays under the Windows command-line length limit.
 */
async function withTextFiles<T>(
  values: Record<string, string | undefined>,
  fn: (refs: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ado-search-mcp-"));
  try {
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!value) continue;
      const path = join(dir, `${key}.html`);
      await writeFile(path, value, "utf8");
      refs[key] = `@${path}`;
    }
    return await fn(refs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
    "List comments on a work item with each comment's id (fetched live from Azure DevOps)",
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
    "ado_get_fields",
    "Read raw field values of a work item live from Azure DevOps as JSON {field: value}. Description and " +
      "acceptance criteria keep their HTML (ado_show strips it), so use this before editing them with ado_update.",
    {
      work_item_id: z.number().int().describe("Work item ID"),
      fields: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Field reference names, e.g. System.Description (default: type, title, state, assignee, tags, " +
            "story points, description, acceptance criteria). Identity fields return the email; empty fields return null.",
        ),
    },
    async (params) => {
      const args = ["get-fields", String(params.work_item_id)];
      for (const f of params.fields ?? []) args.push("--field", f);
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
    "ado_mentions",
    "List comments that @mention you (the authenticated user), newest first, live from Azure DevOps. Covers " +
      "the last 30 days (WIQL @RecentMentions). Each record shows the work item id, title, state, type and " +
      "assignee, then the comment id, author, created date (UTC) and plain text with mentions as @Name.",
    {
      since: z
        .string()
        .min(1)
        .optional()
        .describe("Keep only comments created or modified after this ISO datetime, UTC (e.g. 2026-10-15T00:00:00Z)"),
      limit: z.number().int().min(1).max(500).default(50).describe("Max comments"),
      include_own: z.boolean().default(false).describe("Keep comments you wrote yourself (dropped by default)"),
    },
    async (params) => {
      const args = ["mentions", "--limit", String(params.limit)];
      if (params.since) args.push("--since", params.since);
      if (params.include_own) args.push("--include-own");
      try {
        const result = await runAdoSearch(config, args, { timeout: 180_000 });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(cliOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  // ── Test Plans and wiki pages (live, ado-search >= 1.19) ──

  const PROJECT_OPT = z
    .string()
    .min(1)
    .optional()
    .describe("Azure DevOps project name (default: the configured project)");

  async function liveJson(args: string[], project?: string) {
    if (project) args.push("--project", project);
    args.push("--json");
    try {
      const result = await runAdoSearch(config, args, { timeout: 300_000 });
      if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
      return toMcpResult(JSON.parse(result.stdout));
    } catch (err) {
      return toMcpError(String(err));
    }
  }

  server.tool(
    "ado_test_plans",
    "List Azure Test Plans live: id, name, state, owner, area, iteration, start/end dates, root suite id.",
    {
      project: PROJECT_OPT,
      owner: z.string().min(1).optional().describe("Keep plans whose owner name or email contains this text"),
      active: z.boolean().default(false).describe("Only active plans"),
    },
    async (params) => {
      const args = ["test-plans"];
      if (params.owner) args.push("--owner", params.owner);
      if (params.active) args.push("--active");
      return liveJson(args, params.project);
    },
  );

  server.tool(
    "ado_test_suites",
    "List a test plan's suites live, depth-first with depth and path: type (staticTestSuite, " +
      "requirementTestSuite, dynamicTestSuite), linked requirement id, query, default testers.",
    {
      plan_id: z.number().int().describe("Test plan ID"),
      project: PROJECT_OPT,
    },
    async (params) => liveJson(["test-suites", String(params.plan_id)], params.project),
  );

  server.tool(
    "ado_test_cases",
    "List the test cases in one suite live: steps as {action, expected} (shared steps as {shared_steps: id}), " +
      "parameters, tester/configuration assignments and the requested fields.",
    {
      plan_id: z.number().int().describe("Test plan ID"),
      suite_id: z.number().int().describe("Test suite ID"),
      fields: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Field reference names (default: title, state, created by/date, assignee, area, tags, priority, " +
            "automation status, steps, parameters)",
        ),
      project: PROJECT_OPT,
    },
    async (params) => {
      const args = ["test-cases", String(params.plan_id), String(params.suite_id)];
      for (const f of params.fields ?? []) args.push("--field", f);
      return liveJson(args, params.project);
    },
  );

  server.tool(
    "ado_test_points",
    "List the test points in one suite live: test case, configuration, tester, latest outcome, last run id/date, run by.",
    {
      plan_id: z.number().int().describe("Test plan ID"),
      suite_id: z.number().int().describe("Test suite ID"),
      project: PROJECT_OPT,
    },
    async (params) =>
      liveJson(["test-points", String(params.plan_id), String(params.suite_id)], params.project),
  );

  server.tool(
    "ado_test_runs",
    "List test runs live: name, state, manual/automated, owner, dates, passed/total, unanalyzed, n/a, incomplete.",
    {
      plan_id: z.number().int().optional().describe("Only runs of this test plan"),
      limit: z.number().int().min(1).optional().describe("Stop after this many runs"),
      project: PROJECT_OPT,
    },
    async (params) => {
      const args = ["test-runs"];
      if (params.plan_id) args.push("--plan", String(params.plan_id));
      if (params.limit) args.push("--limit", String(params.limit));
      return liveJson(args, params.project);
    },
  );

  server.tool(
    "ado_test_results",
    "List one test run's results live: test case, outcome, configuration, tester, date, comment/error, linked bug ids.",
    {
      run_id: z.number().int().describe("Test run ID"),
      project: PROJECT_OPT,
    },
    async (params) => liveJson(["test-results", String(params.run_id)], params.project),
  );

  server.tool(
    "ado_wiki_show",
    "Read a wiki page's markdown live from any project, or list the wiki's page paths when path is omitted.",
    {
      path: z.string().min(1).optional().describe("Page path, e.g. '/QA SOP' (omit to list page paths)"),
      wiki: z.string().min(1).optional().describe("Wiki name (default: the project's only wiki)"),
      project: PROJECT_OPT,
    },
    async (params) => {
      const args = ["wiki-show"];
      if (params.path) args.push(params.path);
      if (params.wiki) args.push("--wiki", params.wiki);
      if (params.project) args.push("--project", params.project);
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
    "ado_wiki_update",
    "Replace a wiki page's markdown. Reads the live page first and sends its ETag (If-Match), so a page " +
      "changed in between is refused. Use dry_run first: it returns the unified diff and changes nothing.",
    {
      path: z.string().min(1).describe("Page path, e.g. '/QA SOP'"),
      content: z.string().describe("Full new markdown content of the page"),
      wiki: z.string().min(1).optional().describe("Wiki name (default: the project's only wiki)"),
      project: PROJECT_OPT,
      comment: z.string().min(1).optional().describe("Revision comment stored with the change"),
      create: z.boolean().default(false).describe("Create the page if it does not exist"),
      dry_run: z.boolean().default(false).describe("Return the diff against the live page only"),
    },
    async (params) => {
      const dir = await mkdtemp(join(tmpdir(), "ado-search-mcp-"));
      try {
        const file = join(dir, "page.md");
        await writeFile(file, params.content, "utf8");
        const args = ["wiki-update", params.path, file];
        if (params.wiki) args.push("--wiki", params.wiki);
        if (params.project) args.push("--project", params.project);
        if (params.comment) args.push("--comment", params.comment);
        if (params.create) args.push("--create");
        if (params.dry_run) args.push("--dry-run");
        const result = await runAdoSearch(config, args, { timeout: 120_000 });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(cliOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      } finally {
        await rm(dir, { recursive: true, force: true });
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
        const result = await withTextFiles(
          { description: params.description, acceptance_criteria: params.acceptance_criteria },
          (refs) => {
            if (refs.description) args.push("--description", refs.description);
            if (refs.acceptance_criteria) args.push("--acceptance-criteria", refs.acceptance_criteria);
            return runAdoSearch(config, args, { timeout: 120_000 });
          },
        );
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(cliOutput(result));
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
        const result = await withTextFiles(
          { description: params.description, acceptance_criteria: params.acceptance_criteria },
          (refs) => {
            if (refs.description) args.push("--description", refs.description);
            if (refs.acceptance_criteria) args.push("--acceptance-criteria", refs.acceptance_criteria);
            return runAdoSearch(config, args, { timeout: 120_000 });
          },
        );
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(cliOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_add_comment",
    "Add a comment to a work item. Tag people with @Display Name or @email; each tag becomes an ADO mention that notifies the person.",
    {
      work_item_id: z.number().int().describe("Work item ID"),
      text: z
        .string()
        .min(1)
        .describe(
          "Comment text (HTML supported). Tag people with @Display Name or @email, e.g. " +
            '"@Jane Doe (CTR), please retest"; a tag may start the text. If a tag is unknown or ' +
            "names several people, nothing is posted and the error lists the candidates. " +
            "Write &#64; for a literal @.",
        ),
      resolve_mentions: z
        .boolean()
        .optional()
        .describe("Set false to post the text as-is without converting @tags to mentions (default true)"),
    },
    async (params) => {
      try {
        const result = await withTextFiles({ text: params.text }, (refs) => {
          const args = ["add-comment", String(params.work_item_id), refs.text];
          args.push(params.resolve_mentions === false ? "--no-mentions" : "--strict-mentions");
          return runAdoSearch(config, args, { timeout: 120_000 });
        });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(cliOutput(result));
      } catch (err) {
        return toMcpError(String(err));
      }
    },
  );

  server.tool(
    "ado_edit_comment",
    "Replace the text of an existing comment on a work item. Get the comment id from ado_list_comments. @tags become mentions as in ado_add_comment.",
    {
      work_item_id: z.number().int().describe("Work item ID"),
      comment_id: z.number().int().describe("Comment ID (shown by ado_list_comments)"),
      text: z
        .string()
        .min(1)
        .describe(
          "New comment text (HTML supported); replaces the whole comment. @tags work as in " +
            "ado_add_comment; if a tag is unknown or names several people, nothing is changed. " +
            "Write &#64; for a literal @.",
        ),
      resolve_mentions: z
        .boolean()
        .optional()
        .describe("Set false to save the text as-is without converting @tags to mentions (default true)"),
    },
    async (params) => {
      try {
        const result = await withTextFiles({ text: params.text }, (refs) => {
          const args = ["edit-comment", String(params.work_item_id), String(params.comment_id), refs.text];
          args.push(params.resolve_mentions === false ? "--no-mentions" : "--strict-mentions");
          return runAdoSearch(config, args, { timeout: 120_000 });
        });
        if (result.exitCode !== 0) return toMcpError(result.stderr || result.stdout);
        return toMcpText(cliOutput(result));
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
