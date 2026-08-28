/**
 * Builds an MCP server instance exposing Instantly.ai as a set of tools.
 *
 * The tools are read-first and analytics-focused, which is what the
 * client-acquisition workflow needs: pull campaign metrics, compare
 * A/B (step/variant) performance, read replies, monitor deliverability,
 * and query leads. A guarded generic escape hatch is included for
 * endpoints not yet given a first-class tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstantlyClient, InstantlyError, type Query } from "./instantly.js";

const SERVER_NAME = "instantly-ai";
const SERVER_VERSION = "1.2.0";

/** Format any value as a pretty JSON tool result. */
function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Wrap a tool handler with consistent Instantly error reporting. */
function safe<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const data = await fn(args);
      return jsonResult(data);
    } catch (err) {
      if (err instanceof InstantlyError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Instantly API error (HTTP ${err.status}): ${err.message}\n\n${JSON.stringify(
                err.body,
                null,
                2,
              )}`,
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unexpected error: ${(err as Error).message}` }],
      };
    }
  };
}

export function buildServer(client: InstantlyClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for Instantly.ai cold-email campaigns. Use the analytics tools to measure " +
        "open/reply/bounce rates, compare sequence steps and A/B variants (get_campaign_steps_analytics), " +
        "track trends over time (get_daily_campaign_analytics), read replies (list_emails), " +
        "monitor sender deliverability/warmup (list_accounts, get_warmup_analytics), and query leads " +
        "(list_leads). Dates use YYYY-MM-DD. Prefer the specific tools; use instantly_api_request " +
        "only for endpoints without a dedicated tool.",
    },
  );

  // ---- Campaigns ------------------------------------------------------------

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description:
        "List email campaigns with id, name and status. Use this first to find campaign IDs " +
        "for the analytics tools. Supports search and pagination.",
      inputSchema: {
        search: z.string().optional().describe("Filter campaigns by name."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z
          .string()
          .optional()
          .describe("Pagination cursor: the id of the last item from the previous page."),
        tag_ids: z.array(z.string()).optional().describe("Filter by tag IDs."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns", {
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        tag_ids: a.tag_ids,
      } as Query),
    ),
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Get campaign",
      description: "Get full configuration and status for a single campaign by ID.",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID (UUID)."),
      },
    },
    safe(async (a) => client.get(`/campaigns/${encodeURIComponent(a.campaign_id)}`)),
  );

  // ---- Analytics ------------------------------------------------------------

  server.registerTool(
    "get_campaign_analytics",
    {
      title: "Get campaign analytics",
      description:
        "Per-campaign totals: leads, contacted, opens, replies, link clicks, bounces, " +
        "unsubscribes, completed and emails sent. Omit campaign_ids for all campaigns. " +
        "Optionally scope to a date range. This is the main tool for comparing whole campaigns.",
      inputSchema: {
        campaign_ids: z
          .array(z.string())
          .optional()
          .describe("One or more campaign IDs. Omit for all campaigns."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
        campaign_status: z
          .number()
          .int()
          .optional()
          .describe("Filter by campaign status code (e.g. 1=active, 2=paused, 3=completed)."),
        include_opportunities: z
          .boolean()
          .optional()
          .describe("Include opportunity/CRM counts in the response."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics", {
        id: a.campaign_ids,
        start_date: a.start_date,
        end_date: a.end_date,
        campaign_status: a.campaign_status,
        expand_crm_events: a.include_opportunities,
      } as Query),
    ),
  );

  server.registerTool(
    "get_campaign_analytics_overview",
    {
      title: "Get analytics overview",
      description:
        "Aggregated analytics across campaigns (a single rolled-up summary rather than per-campaign rows). " +
        "Useful for an at-a-glance account health snapshot.",
      inputSchema: {
        campaign_ids: z.array(z.string()).optional().describe("Scope to specific campaign IDs."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
        campaign_status: z.number().int().optional().describe("Filter by campaign status code."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics/overview", {
        id: a.campaign_ids,
        start_date: a.start_date,
        end_date: a.end_date,
        campaign_status: a.campaign_status,
      } as Query),
    ),
  );

  server.registerTool(
    "get_daily_campaign_analytics",
    {
      title: "Get daily campaign analytics",
      description:
        "Day-by-day metrics (date, sent, opened, unique_opened, replies, unique_replies, clicks, " +
        "unique_clicks). Use this to see trends over time and to check the effect of a change made " +
        "on a specific date.",
      inputSchema: {
        campaign_id: z.string().optional().describe("Campaign ID. Omit for all campaigns."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
        campaign_status: z.number().int().optional().describe("Filter by campaign status code."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics/daily", {
        campaign_id: a.campaign_id,
        start_date: a.start_date,
        end_date: a.end_date,
        campaign_status: a.campaign_status,
      } as Query),
    ),
  );

  server.registerTool(
    "get_campaign_steps_analytics",
    {
      title: "Get step / variant analytics (A/B tests)",
      description:
        "Per-sequence-step and per-variant metrics (step, variant, sent, opened, unique_opened, " +
        "replies, unique_replies, clicks, unique_clicks). This is the tool for evaluating split " +
        "tests: compare subject-line or copy variants within a step to decide the winner before " +
        "changing the next variable.",
      inputSchema: {
        campaign_id: z.string().optional().describe("Campaign ID. Omit for all campaigns."),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)."),
      },
    },
    safe(async (a) =>
      client.get("/campaigns/analytics/steps", {
        campaign_id: a.campaign_id,
        start_date: a.start_date,
        end_date: a.end_date,
      } as Query),
    ),
  );

  // ---- Leads ----------------------------------------------------------------

  server.registerTool(
    "list_leads",
    {
      title: "List / search leads",
      description:
        "List leads, optionally scoped to a campaign or lead list, with search and status filters. " +
        "Returns lead records (email, name, company, status, custom variables).",
      inputSchema: {
        campaign_id: z.string().optional().describe("Restrict to leads in this campaign."),
        list_id: z.string().optional().describe("Restrict to leads in this lead list."),
        search: z.string().optional().describe("Free-text search (email, name, company)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
        filter: z
          .record(z.any())
          .optional()
          .describe("Advanced filter object passed straight through to the Instantly leads filter."),
      },
    },
    safe(async (a) =>
      client.post("/leads/list", {
        campaign: a.campaign_id,
        list_id: a.list_id,
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        ...(a.filter ?? {}),
      }),
    ),
  );

  server.registerTool(
    "get_lead",
    {
      title: "Get lead",
      description: "Get a single lead by ID, including status and all custom variables.",
      inputSchema: {
        lead_id: z.string().describe("The lead ID."),
      },
    },
    safe(async (a) => client.get(`/leads/${encodeURIComponent(a.lead_id)}`)),
  );

  // ---- Lead lists -----------------------------------------------------------

  server.registerTool(
    "list_lead_lists",
    {
      title: "List lead lists",
      description:
        "List saved lead lists (e.g. by niche: plumbers, roofing, window installation). Use this " +
        "to find list IDs, reference existing lists, or avoid duplicating a niche already built. " +
        "Pass a list_id from here to list_leads to see the leads inside a list.",
      inputSchema: {
        search: z.string().optional().describe("Filter lead lists by name."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
      },
    },
    safe(async (a) =>
      client.get("/lead-lists", {
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
      } as Query),
    ),
  );

  server.registerTool(
    "get_lead_list",
    {
      title: "Get lead list",
      description: "Get a single lead list by ID, including its name and metadata.",
      inputSchema: {
        list_id: z.string().describe("The lead list ID."),
      },
    },
    safe(async (a) => client.get(`/lead-lists/${encodeURIComponent(a.list_id)}`)),
  );

  // ---- Emails / replies -----------------------------------------------------

  server.registerTool(
    "list_emails",
    {
      title: "List emails / replies",
      description:
        "List emails sent and received (the unibox). Use this to read prospect replies and " +
        "message threads. Filter by campaign or sending account.",
      inputSchema: {
        campaign_id: z.string().optional().describe("Restrict to a campaign."),
        eaccount: z.string().optional().describe("Restrict to a sending account email address."),
        search: z.string().optional().describe("Free-text search over emails."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
        i_status: z
          .number()
          .int()
          .optional()
          .describe("Interest status filter (e.g. interested / not interested codes)."),
      },
    },
    safe(async (a) =>
      client.get("/emails", {
        campaign_id: a.campaign_id,
        eaccount: a.eaccount,
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        i_status: a.i_status,
      } as Query),
    ),
  );

  server.registerTool(
    "get_email",
    {
      title: "Get email",
      description: "Get the full content of a single email/message by ID.",
      inputSchema: {
        email_id: z.string().describe("The email ID."),
      },
    },
    safe(async (a) => client.get(`/emails/${encodeURIComponent(a.email_id)}`)),
  );

  // ---- Sending accounts / deliverability ------------------------------------

  server.registerTool(
    "list_accounts",
    {
      title: "List sending accounts",
      description:
        "List connected sending accounts (inboxes) with status and warmup info. Use this to " +
        "monitor deliverability and spot disconnected or paused inboxes.",
      inputSchema: {
        search: z.string().optional().describe("Filter by email address."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        starting_after: z.string().optional().describe("Pagination cursor from a previous page."),
        tag_ids: z.array(z.string()).optional().describe("Filter by tag IDs."),
      },
    },
    safe(async (a) =>
      client.get("/accounts", {
        search: a.search,
        limit: a.limit ?? 20,
        starting_after: a.starting_after,
        tag_ids: a.tag_ids,
      } as Query),
    ),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get sending account",
      description: "Get details for a single sending account by its email address.",
      inputSchema: {
        email: z.string().describe("The sending account email address."),
      },
    },
    safe(async (a) => client.get(`/accounts/${encodeURIComponent(a.email)}`)),
  );

  server.registerTool(
    "get_warmup_analytics",
    {
      title: "Get warmup analytics",
      description:
        "Warmup performance for one or more sending accounts (health / deliverability signal). " +
        "Provide the account email addresses to inspect.",
      inputSchema: {
        emails: z.array(z.string()).min(1).describe("Sending account email addresses."),
      },
    },
    safe(async (a) => client.post("/accounts/warmup-analytics", { emails: a.emails })),
  );

  // ---- Generic escape hatch (guarded) --------------------------------------

  server.registerTool(
    "instantly_api_request",
    {
      title: "Raw Instantly API request",
      description:
        "Power tool: call any Instantly API v2 endpoint not covered by a dedicated tool. " +
        "Only GET and POST are allowed (no mutations via PATCH/DELETE). Path is relative to " +
        "the API v2 base, e.g. '/campaigns' or '/leads/list'.",
      inputSchema: {
        method: z.enum(["GET", "POST"]).describe("HTTP method."),
        path: z.string().describe("Path relative to https://api.instantly.ai/api/v2, e.g. '/campaigns'."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe("Query parameters."),
        body: z.record(z.any()).optional().describe("JSON body (POST only)."),
      },
    },
    safe(async (a) => {
      const path = a.path.replace(/^\/api\/v2/, "");
      return client.request(a.method, path, { query: a.query as Query, body: a.body });
    }),
  );

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
