import { expect } from "vitest";
import type { LinearConfig } from "../src/config.js";
import { AppTokenSource, LinearApi, LINEAR_GRAPHQL_URL, LINEAR_TOKEN_URL, type Fetch } from "../src/linear/api.js";

export const companyId = "company-1";

export function config(mode: LinearConfig["mode"] = "act", extra: Partial<LinearConfig> = {}): LinearConfig {
  return {
    linearOrganizationId: "org-1",
    webhookSecret: { type: "secret_ref", secretId: "s1" },
    linearClientId: "client-1",
    linearClientSecret: { type: "secret_ref", secretId: "s2" },
    mode,
    routing: {
      leads: { delivery: { paperclipProjectId: "proj-delivery", agentId: "agent-delivery" } },
      projects: { "lin-website": "delivery" },
    },
    states: {},
    closeOnDone: false,
    ...extra,
  };
}

/** A fake Linear: mints tokens, answers the issue query, records every write. */
export function fakeLinear(issue: { labels: string[]; projectId: string | null }) {
  const activities: Array<{ type: string; body: string }> = [];
  const urls: Array<{ label: string; url: string }> = [];
  const stateMoves: Array<{ id: string; stateId: string }> = [];
  let tokens = 0;
  const fetch: Fetch = async (url, init) => {
    if (url === LINEAR_TOKEN_URL) {
      tokens++;
      expect(init.body).toContain("grant_type=client_credentials");
      return { status: 200, ok: true, json: async () => ({ access_token: `tok-${tokens}`, expires_in: 2592000 }) };
    }
    expect(url).toBe(LINEAR_GRAPHQL_URL);
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: { id?: string; input?: { content?: { type: string; body: string }; addedExternalUrls?: typeof urls; stateId?: string } };
    };
    const ok = (data: unknown) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("agentActivityCreate")) {
      activities.push(variables.input!.content!);
      return ok({ agentActivityCreate: { success: true } });
    }
    if (query.includes("agentSessionUpdate")) {
      urls.push(...variables.input!.addedExternalUrls!);
      return ok({ agentSessionUpdate: { success: true } });
    }
    if (query.includes("issueUpdate")) {
      stateMoves.push({ id: variables.id!, stateId: variables.input!.stateId! });
      return ok({ issueUpdate: { success: true } });
    }
    return ok({
      issue: {
        id: "lin-issue-1",
        identifier: "DIL-1",
        title: "Fix the footer",
        description: "It overlaps on mobile.",
        url: "https://linear.app/x/issue/DIL-1",
        project: issue.projectId ? { id: issue.projectId } : null,
        labels: { nodes: issue.labels.map((name) => ({ name })) },
      },
    });
  };
  return {
    fetch,
    activities,
    urls,
    stateMoves,
    tokenCount: () => tokens,
    api: new LinearApi(fetch, new AppTokenSource(fetch, "client-1", "secret")),
  };
}

export const created = { action: "created", agentSession: { id: "sess-1", issueId: "lin-issue-1", creatorId: "user-ryan" } };
