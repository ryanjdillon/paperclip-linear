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

/** The team of every workflow state the fake knows. */
export const stateTeamId = "team-1";

/** The fake Linear's app user, the viewer of its app token. */
export const appUserId = "app-user-1";

/** An agent session as the fake's `agentSessions` query returns it. */
export interface FakeSession {
  id: string;
  createdAt: string;
  status: string;
  dismissedAt?: string | null;
  appUser: { id: string };
  creator?: { id: string } | null;
  issue?: { id: string; state?: { type: string } | null; delegate?: { id: string } | null } | null;
}

/** An issue delegated to the fake's app, in a backlog state. */
export function delegatedIssue(id = "lin-issue-1", stateType = "backlog") {
  return { id, state: { type: stateType }, delegate: { id: appUserId } };
}

/** A session of the fake's app on its issue, created `ageMs` before `now`. */
export function appSession(id: string, now: number, ageMs: number, extra: Partial<FakeSession> = {}): FakeSession {
  return {
    id,
    createdAt: new Date(now - ageMs).toISOString(),
    status: "pending",
    appUser: { id: appUserId },
    creator: { id: "user-ryan" },
    issue: delegatedIssue(),
    ...extra,
  };
}

/**
 * A fake Linear: mints tokens, answers the issue query, records every write.
 * The issue is in `stateTeamId` unless `teamId` says otherwise; null gives no team.
 * `sessions` answers the agent sessions query, in the given order.
 */
export function fakeLinear(
  issue: { labels: string[]; projectId: string | null; stateType?: string; teamId?: string | null },
  sessions: FakeSession[] = [],
) {
  const activities: Array<{ type: string; body: string }> = [];
  const urls: Array<{ label: string; url: string }> = [];
  const stateMoves: Array<{ id: string; stateId: string }> = [];
  const teamQueries: Array<{ issue: string; state: string }> = [];
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
      variables: { id?: string; issue?: string; state?: string; input?: { content?: { type: string; body: string }; addedExternalUrls?: typeof urls; stateId?: string } };
    };
    const ok = (data: unknown) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("AppAgentSessions")) {
      // The fields recovery reads, so a renamed field fails a test.
      for (const field of ["viewer { id }", "orderBy: createdAt", "createdAt", "status", "dismissedAt", "appUser { id }", "creator { id }", "state { type }", "delegate { id }"]) {
        expect(query).toContain(field);
      }
      return ok({ viewer: { id: appUserId }, agentSessions: { nodes: sessions } });
    }
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
    if (query.includes("StateTeams")) {
      teamQueries.push({ issue: variables.issue!, state: variables.state! });
      const team = issue.teamId === null ? null : { id: issue.teamId ?? stateTeamId };
      return ok({ issue: { team }, workflowState: { team: { id: stateTeamId } } });
    }
    if (query.includes("IssueState")) return ok({ issue: { state: { type: issue.stateType ?? "started" } } });
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
    issue,
    sessions,
    fetch,
    activities,
    urls,
    stateMoves,
    teamQueries,
    tokenCount: () => tokens,
    api: new LinearApi(fetch, new AppTokenSource(fetch, "client-1", "secret")),
  };
}

export const created = { action: "created", agentSession: { id: "sess-1", issueId: "lin-issue-1", creatorId: "user-ryan" } };
