import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { LinearConfig } from "./config.js";
import type { LinearApi } from "./linear/api.js";
import { route } from "./routing.js";

export const ORIGIN_KIND = "plugin:ryanjdillon.paperclip-linear" as const;

/** What the plugin remembers about one Linear agent session. */
export interface SessionLink {
  companyId: string;
  linearIssueId: string;
  /** The Linear user who delegated the issue; every agent action traces to them. */
  delegatedBy: string | null;
  status: "routed" | "awaiting_route";
  paperclipIssueId?: string;
  lead?: string;
}

export function sessionKey(agentSessionId: string) {
  return { scopeKind: "instance", stateKey: `linear-session:${agentSessionId}` } as const;
}

/** Paperclip task id to the Linear agent session it came from. */
export function taskKey(paperclipIssueId: string) {
  return { scopeKind: "instance", stateKey: `paperclip-task:${paperclipIssueId}` } as const;
}

export type IntakeOutcome =
  | "ignored"
  | "observed"
  | "duplicate_session"
  | "asked"
  | "routed"
  | "prompt_forwarded"
  | "prompt_unlinked";

export interface AgentSessionPayload {
  type?: unknown;
  action?: string;
  agentSession?: {
    id?: string;
    issueId?: string;
    issue?: { id?: string };
    creatorId?: string;
    creator?: { id?: string };
  };
  agentActivity?: { body?: string; content?: { body?: string } };
}

export interface IntakeDeps {
  ctx: PluginContext;
  linear: LinearApi;
  companyId: string;
  config: LinearConfig;
}

/**
 * Handle an `AgentSessionEvent` (ADRs 0001 to 0003). `created` routes the
 * delegated issue to a lead agent's Paperclip task and wakes it; `prompted`
 * forwards a follow-up to that task. In observe mode nothing is written.
 */
export async function handleAgentSessionEvent(deps: IntakeDeps, payload: AgentSessionPayload): Promise<IntakeOutcome> {
  const session = payload.agentSession;
  const sessionId = session?.id;
  const linearIssueId = session?.issueId ?? session?.issue?.id;
  if (!sessionId || !linearIssueId) return "ignored";

  const link = (await deps.ctx.state.get(sessionKey(sessionId))) as SessionLink | null;
  if (payload.action === "prompted") {
    if (!link) return "prompt_unlinked";
    if (link.status === "awaiting_route") return routeSession(deps, sessionId, linearIssueId, link.delegatedBy);
    const body = payload.agentActivity?.body ?? payload.agentActivity?.content?.body ?? "";
    if (deps.config.mode === "observe") return "observed";
    await deps.ctx.issues.createComment(link.paperclipIssueId!, `From Linear:\n\n${body}`, deps.companyId);
    await deps.ctx.issues.requestWakeup(link.paperclipIssueId!, deps.companyId, {
      reason: "Follow-up in Linear",
      idempotencyKey: `linear-prompt:${sessionId}:${body.length}:${hash(body)}`,
    });
    return "prompt_forwarded";
  }
  if (payload.action !== "created") return "ignored";
  if (link) return "duplicate_session";
  const delegatedBy = session?.creatorId ?? session?.creator?.id ?? null;
  return routeSession(deps, sessionId, linearIssueId, delegatedBy);
}

async function routeSession(
  deps: IntakeDeps,
  sessionId: string,
  linearIssueId: string,
  delegatedBy: string | null,
): Promise<IntakeOutcome> {
  const { ctx, linear, companyId, config } = deps;
  const observe = config.mode === "observe";
  // Linear marks a session unresponsive without an activity within 10 seconds.
  if (!observe) await linear.postActivity(sessionId, "thought", "Received. Routing to a Paperclip agent.", true);

  const issue = await linear.issue(linearIssueId);
  const decision = route(issue, config.routing);
  if (observe) {
    ctx.logger.info("Observe mode: would route a Linear session", { sessionId, issue: issue.identifier, decision });
    return "observed";
  }
  if (decision.kind === "ask") {
    const leads = Object.keys(config.routing.leads).sort();
    await ctx.state.set(sessionKey(sessionId), {
      companyId,
      linearIssueId,
      delegatedBy,
      status: "awaiting_route",
    } satisfies SessionLink);
    await linear.postActivity(
      sessionId,
      "elicitation",
      `Which lead should take this? Add a \`lead:<name>\` label, then reply here. Leads: ${leads.join(", ") || "none configured"}.`,
    );
    return "asked";
  }

  const task = await ctx.issues.create({
    companyId,
    projectId: decision.lead.paperclipProjectId,
    title: `${issue.identifier} ${issue.title}`,
    description: `${issue.description}\n\nLinear: ${issue.url}`.trim(),
    assigneeAgentId: decision.lead.agentId,
    originKind: ORIGIN_KIND,
    originId: issue.id,
  });
  await ctx.state.set(sessionKey(sessionId), {
    companyId,
    linearIssueId,
    delegatedBy,
    status: "routed",
    paperclipIssueId: task.id,
    lead: decision.name,
  } satisfies SessionLink);
  await ctx.state.set(taskKey(task.id), sessionId);
  await ctx.issues.requestWakeup(task.id, companyId, {
    reason: "Delegated in Linear",
    idempotencyKey: `linear-session:${sessionId}`,
  });
  await linear.postActivity(sessionId, "thought", `Queued in Paperclip for the ${decision.name} lead.`);
  return "routed";
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
