import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { LinearConfig } from "./config.js";
import { sessionKey, taskKey, type SessionLink } from "./intake.js";
import type { LinearApi } from "./linear/api.js";

/** Paperclip events the plugin reports back to Linear. */
export const STATUS_EVENTS = [
  "agent.run.started",
  "agent.run.failed",
  "issue.comment.created",
  "approval.created",
  "issue.updated",
] as const;

export type StatusOutcome = "unlinked" | "skipped" | "duplicate" | "observed" | "reported";

export interface StatusDeps {
  ctx: PluginContext;
  linear: LinearApi;
  config: LinearConfig;
  /** Base URL of the Paperclip UI, for links back; optional. */
  paperclipUrl?: string;
}

/** Pull request links worth attaching to the Linear session. */
const PR_URL = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.com\/[\w./-]+\/-\/merge_requests\/\d+)/g;

/** Outbound write keys, recorded before the call so a repeat never writes twice. */
export function outboundKey(key: string) {
  return { scopeKind: "instance", stateKey: `linear-outbound:${key}` } as const;
}

/** When the plugin last posted to a session; the reconcile job keeps quiet sessions alive. */
export function lastActivityKey(agentSessionId: string) {
  return { scopeKind: "instance", stateKey: `linear-last-activity:${agentSessionId}` } as const;
}

/**
 * Report one Paperclip event on a linked task to its Linear agent session
 * (design doc, "What shows up in Linear"). Linear keeps its own fields; the
 * plugin only adds activity, links, and configured state moves.
 */
export async function handleStatusEvent(deps: StatusDeps, event: PluginEvent): Promise<StatusOutcome> {
  const { ctx, linear, config } = deps;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const taskId =
    event.eventType.startsWith("agent.run.") || event.eventType.startsWith("approval.")
      ? (payload.issueId as string | undefined)
      : event.entityId;
  if (!taskId) return "unlinked";
  const sessionId = (await ctx.state.get(taskKey(taskId))) as string | null;
  if (!sessionId) return "unlinked";
  const link = (await ctx.state.get(sessionKey(sessionId))) as SessionLink | null;
  if (!link) return "unlinked";

  const plan = await planFor(deps, event, taskId, payload, link);
  if (!plan) return "skipped";
  if (config.mode === "observe") {
    ctx.logger.info("Observe mode: would report to Linear", { sessionId, event: event.eventType, kind: plan.kind });
    return "observed";
  }
  const key = outboundKey(plan.key ?? `${event.eventId}:${plan.kind}`);
  if ((await ctx.state.get(key)) !== null) return "duplicate";
  await ctx.state.set(key, { at: event.occurredAt, sessionId });
  await plan.run(sessionId);
  await ctx.state.set(lastActivityKey(sessionId), Date.parse(event.occurredAt) || Date.now());
  return "reported";
}

interface Plan {
  kind: string;
  /** A stable key the reconcile job can check; defaults to the event id and kind. */
  key?: string;
  run(sessionId: string): Promise<void>;
}

/** Outbound keys for writes the reconcile job may need to replay. */
export const commentOutbound = (commentId: string) => `comment:${commentId}`;
export const doneOutbound = (taskId: string) => `done:${taskId}`;

async function planFor(
  deps: StatusDeps,
  event: PluginEvent,
  taskId: string,
  payload: Record<string, unknown>,
  link: SessionLink,
): Promise<Plan | null> {
  const { ctx, linear, config } = deps;
  const taskLink = deps.paperclipUrl ? ` ${deps.paperclipUrl.replace(/\/$/, "")}/issues/${taskId}` : "";
  switch (event.eventType) {
    case "agent.run.started":
      return {
        kind: "started",
        run: async (sessionId) => {
          await linear.postActivity(sessionId, "thought", "Working on it in Paperclip.", true);
          if (config.states.started) await linear.setIssueState(link.linearIssueId, config.states.started);
        },
      };
    case "agent.run.failed": {
      const reason = (payload.error as string | null) ?? (payload.errorCode as string | null) ?? "unknown error";
      return {
        kind: "failed",
        run: (sessionId) => linear.postActivity(sessionId, "error", `The Paperclip run failed: ${reason}.${taskLink}`),
      };
    }
    case "issue.comment.created": {
      // Only agents' words go to Linear; the plugin's own comments (imports from
      // Linear) and people's comments in Paperclip do not.
      if (event.actorType !== "agent") return null;
      const commentId = payload.commentId as string | undefined;
      const comments = await ctx.issues.listComments(taskId, event.companyId);
      const comment = comments.find((c) => c.id === commentId) ?? comments.at(-1);
      if (!comment?.body) return null;
      const urls = [...new Set(comment.body.match(PR_URL) ?? [])];
      return {
        kind: "comment",
        key: commentOutbound(comment.id),
        run: async (sessionId) => {
          await linear.postActivity(sessionId, "response", comment.body);
          if (urls.length > 0) await linear.addExternalUrls(sessionId, urls.map((url) => ({ label: "Pull request", url })));
        },
      };
    }
    case "approval.created":
      return {
        kind: "approval",
        run: (sessionId) =>
          linear.postActivity(sessionId, "elicitation", `An approval is waiting in Paperclip before work continues.${taskLink}`),
      };
    case "issue.updated": {
      const status = (payload.status ?? (payload.changes as Record<string, unknown> | undefined)?.status) as string | undefined;
      if (status === "in_review" && config.states.inReview) {
        return { kind: "in_review", run: () => linear.setIssueState(link.linearIssueId, config.states.inReview!) };
      }
      if (status === "done") {
        return {
          kind: "done",
          key: doneOutbound(taskId),
          run: async (sessionId) => {
            await linear.postActivity(sessionId, "response", "Finished in Paperclip.");
            if (config.closeOnDone && config.states.done) await linear.setIssueState(link.linearIssueId, config.states.done);
          },
        };
      }
      return null;
    }
    default:
      return null;
  }
}
