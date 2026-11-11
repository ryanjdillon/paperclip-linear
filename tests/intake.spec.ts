import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { LinearConfig } from "../src/config.js";
import { handleAgentSessionEvent, ORIGIN_KIND, sessionKey, type SessionLink } from "../src/intake.js";
import { AppTokenSource, LinearApi, LINEAR_GRAPHQL_URL, LINEAR_TOKEN_URL, type Fetch } from "../src/linear/api.js";
import manifest from "../src/manifest.js";

const companyId = "company-1";

function config(mode: LinearConfig["mode"] = "act"): LinearConfig {
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
  };
}

/** A fake Linear: mints tokens, answers the issue query, records activities. */
function fakeLinear(issue: { labels: string[]; projectId: string | null }) {
  const activities: Array<{ type: string; body: string }> = [];
  let tokens = 0;
  const fetch: Fetch = async (url, init) => {
    if (url === LINEAR_TOKEN_URL) {
      tokens++;
      expect(init.body).toContain("grant_type=client_credentials");
      return { status: 200, ok: true, json: async () => ({ access_token: `tok-${tokens}`, expires_in: 2592000 }) };
    }
    expect(url).toBe(LINEAR_GRAPHQL_URL);
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: { input?: { content: { type: string; body: string } } } };
    if (query.includes("agentActivityCreate")) {
      activities.push(variables.input!.content);
      return { status: 200, ok: true, json: async () => ({ data: { agentActivityCreate: { success: true } } }) };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "lin-issue-1",
            identifier: "DIL-1",
            title: "Fix the footer",
            description: "It overlaps on mobile.",
            url: "https://linear.app/x/issue/DIL-1",
            project: issue.projectId ? { id: issue.projectId } : null,
            labels: { nodes: issue.labels.map((name) => ({ name })) },
          },
        },
      }),
    };
  };
  return { fetch, activities, tokenCount: () => tokens, api: new LinearApi(fetch, new AppTokenSource(fetch, "client-1", "secret")) };
}

const created = { action: "created", agentSession: { id: "sess-1", issueId: "lin-issue-1", creatorId: "user-ryan" } };

describe("agent session intake", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(async () => {
    // The assertions read tasks and comments; the plugin itself does not need to yet.
    harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issues.read", "issue.comments.read"] });
  });

  it("routes a delegated issue to the project's lead, wakes it, and reports back", async () => {
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    const deps = { ctx: harness.ctx, linear: linear.api, companyId, config: config() };

    expect(await handleAgentSessionEvent(deps, created)).toBe("routed");

    const [task] = await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND });
    expect(task).toMatchObject({ projectId: "proj-delivery", assigneeAgentId: "agent-delivery", title: "DIL-1 Fix the footer", originId: "lin-issue-1" });
    expect(task.description).toContain("https://linear.app/x/issue/DIL-1");
    expect(harness.getState(sessionKey("sess-1"))).toMatchObject({ status: "routed", paperclipIssueId: task.id, delegatedBy: "user-ryan" });
    expect(linear.activities.map((a) => a.type)).toEqual(["thought", "thought"]);
    expect(linear.activities[1].body).toContain("delivery lead");
    expect(linear.tokenCount()).toBe(1);
  });

  it("handles a retried created event once", async () => {
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    const deps = { ctx: harness.ctx, linear: linear.api, companyId, config: config() };
    await handleAgentSessionEvent(deps, created);
    expect(await handleAgentSessionEvent(deps, created)).toBe("duplicate_session");
    expect(await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND })).toHaveLength(1);
  });

  it("asks which lead when nothing matches, then routes on the follow-up", async () => {
    const unmatched = fakeLinear({ labels: [], projectId: null });
    const deps = { ctx: harness.ctx, linear: unmatched.api, companyId, config: config() };
    expect(await handleAgentSessionEvent(deps, created)).toBe("asked");
    expect(unmatched.activities.at(-1)).toMatchObject({ type: "elicitation" });
    expect(unmatched.activities.at(-1)!.body).toContain("delivery");
    expect((harness.getState(sessionKey("sess-1")) as SessionLink).status).toBe("awaiting_route");

    const labelled = fakeLinear({ labels: ["lead:delivery"], projectId: null });
    const prompted = { action: "prompted", agentSession: created.agentSession, agentActivity: { body: "Added the label" } };
    expect(await handleAgentSessionEvent({ ...deps, linear: labelled.api }, prompted)).toBe("routed");
  });

  it("forwards a follow-up prompt to the linked task", async () => {
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    const deps = { ctx: harness.ctx, linear: linear.api, companyId, config: config() };
    await handleAgentSessionEvent(deps, created);
    const prompted = { action: "prompted", agentSession: created.agentSession, agentActivity: { body: "Use the new palette" } };
    expect(await handleAgentSessionEvent(deps, prompted)).toBe("prompt_forwarded");
    const link = harness.getState(sessionKey("sess-1")) as SessionLink;
    const comments = await harness.ctx.issues.listComments(link.paperclipIssueId!, companyId);
    expect(comments.at(-1)?.body).toContain("Use the new palette");
  });

  it("writes nothing in observe mode", async () => {
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    const deps = { ctx: harness.ctx, linear: linear.api, companyId, config: config("observe") };
    expect(await handleAgentSessionEvent(deps, created)).toBe("observed");
    expect(linear.activities).toEqual([]);
    expect(await harness.ctx.issues.list({ companyId })).toEqual([]);
    expect(harness.getState(sessionKey("sess-1"))).toBeUndefined();
  });

  it("ignores prompts for unknown sessions and other actions", async () => {
    const linear = fakeLinear({ labels: [], projectId: null });
    const deps = { ctx: harness.ctx, linear: linear.api, companyId, config: config() };
    expect(await handleAgentSessionEvent(deps, { action: "prompted", agentSession: { id: "nope", issueId: "x" } })).toBe("prompt_unlinked");
    expect(await handleAgentSessionEvent(deps, { action: "updated", agentSession: { id: "s", issueId: "x" } })).toBe("ignored");
    expect(await handleAgentSessionEvent(deps, { action: "created", agentSession: {} })).toBe("ignored");
  });
});

describe("app tokens", () => {
  it("reuses a token until shortly before expiry and replaces it after a 401", async () => {
    let minted = 0;
    let rejectNext = false;
    let clock = 0;
    const fetch: Fetch = async (url) => {
      if (url === LINEAR_TOKEN_URL) {
        minted++;
        return { status: 200, ok: true, json: async () => ({ access_token: `t${minted}`, expires_in: 2 * 24 * 3600 }) };
      }
      if (rejectNext) {
        rejectNext = false;
        return { status: 401, ok: false, json: async () => ({}) };
      }
      return { status: 200, ok: true, json: async () => ({ data: { ok: true } }) };
    };
    const api = new LinearApi(fetch, new AppTokenSource(fetch, "c", "s", () => clock));
    await api.graphql("{ ok }", {});
    await api.graphql("{ ok }", {});
    expect(minted).toBe(1);
    clock = 25 * 3600 * 1000; // past expiry minus a day
    await api.graphql("{ ok }", {});
    expect(minted).toBe(2);
    rejectNext = true;
    await api.graphql("{ ok }", {});
    expect(minted).toBe(3);
  });
});
