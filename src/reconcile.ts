import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { LinearConfig } from "./config.js";
import { ORIGIN_KIND, sessionKey, taskKey, wakeLead, type SessionLink } from "./intake.js";
import type { LinearApi } from "./linear/api.js";
import { commentOutbound, doneOutbound, outboundKey, readActivity, recordActivity } from "./status.js";

export const RECONCILE_JOB = "reconcile";

/** Linear marks a session stale after about 30 minutes without activity. */
export const KEEP_ALIVE_AFTER_MS = 20 * 60 * 1000;

/**
 * The keep-alive text for each open task status. Work that waits keeps its
 * session: only a canceled Linear issue ends it.
 */
const KEEP_ALIVE_TEXT: Record<string, string> = {
  backlog: "Waiting in the Paperclip backlog.",
  todo: "Queued in Paperclip.",
  in_progress: "Still working on it in Paperclip.",
  blocked: "Blocked in Paperclip until another task finishes.",
  in_review: "Waiting for review in Paperclip.",
};

/** Instance state listing the companies the plugin is configured for; jobs carry no company. */
export const COMPANIES_KEY = { scopeKind: "instance", stateKey: "linear-companies" } as const;

export interface ReconcileReport {
  checked: number;
  cancelled: number;
  commentsReplayed: number;
  doneReported: number;
  keptAlive: number;
  woken: number;
  errors: number;
}

/**
 * Bring one company's linked tasks back in line with Linear. Plugin events
 * arrive at most once, so this job replays what was missed: agent comments
 * and completion reports. It also cancels Paperclip tasks whose Linear issue
 * was canceled, wakes routed tasks whose first wake failed, and keeps the
 * sessions of open tasks from going stale, except where a question waits.
 */
export async function reconcileCompany(
  ctx: PluginContext,
  linear: LinearApi,
  companyId: string,
  config: LinearConfig,
  now: number,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, cancelled: 0, commentsReplayed: 0, doneReported: 0, keptAlive: 0, woken: 0, errors: 0 };
  const act = config.mode === "act";
  const tasks = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND });
  for (const task of tasks) {
    const sessionId = (await ctx.state.get(taskKey(task.id))) as string | null;
    if (!sessionId) continue;
    const link = (await ctx.state.get(sessionKey(sessionId))) as SessionLink | null;
    if (!link) continue;
    report.checked++;
    try {
      const open = task.status !== "done" && task.status !== "cancelled";
      if (open && (await linear.issueStateType(link.linearIssueId)) === "canceled") {
        if (act) {
          await ctx.issues.update(task.id, { status: "cancelled" }, companyId);
          await linear.postActivity(sessionId, "response", "The Linear issue was canceled, so the Paperclip task was cancelled.");
        }
        report.cancelled++;
        continue;
      }

      // A routed task whose wake was never queued: intake's wake failed, or an
      // earlier repair failed half-way. A task that the owner moved to backlog
      // after the wake has `wokenAt`, so it stays where the owner put it.
      if ((task.status === "backlog" || task.status === "todo") && link.status === "routed" && !link.wokenAt) {
        if (act) {
          if (task.status === "backlog") await ctx.issues.update(task.id, { status: "todo" }, companyId);
          const queued = await wakeLead(ctx, companyId, sessionId, link, now, `linear-session:${sessionId}:reconcile:${now}`);
          if (queued) {
            await linear.postActivity(sessionId, "thought", `Queued in Paperclip for the ${link.lead} lead.`);
            await recordActivity(ctx, sessionId, now, "thought");
          }
        }
        report.woken++;
        continue;
      }

      const comments = await ctx.issues.listComments(task.id, companyId);
      for (const comment of comments) {
        if (comment.authorType !== "agent" || !comment.body) continue;
        const key = outboundKey(commentOutbound(comment.id));
        if ((await ctx.state.get(key)) !== null) continue;
        if (act) {
          await ctx.state.set(key, { at: new Date(now).toISOString(), sessionId, replayed: true });
          await linear.postActivity(sessionId, "response", comment.body);
          await recordActivity(ctx, sessionId, now, "response");
        }
        report.commentsReplayed++;
      }

      if (task.status === "done") {
        const key = outboundKey(doneOutbound(task.id));
        if ((await ctx.state.get(key)) === null) {
          if (act) {
            await ctx.state.set(key, { at: new Date(now).toISOString(), sessionId, replayed: true });
            await linear.postActivity(sessionId, "response", "Finished in Paperclip.");
            await recordActivity(ctx, sessionId, now, "response");
            if (config.closeOnDone && config.states.done) await linear.setIssueState(link.linearIssueId, config.states.done);
          }
          report.doneReported++;
        }
      } else if (task.status in KEEP_ALIVE_TEXT) {
        const last = await readActivity(ctx, sessionId);
        // A question to the owner keeps its session in "Needs input" without
        // help, and a thought would replace that state. The same holds for the
        // agent's answer on a task in review: the session waits for the owner.
        const waitsForOwner =
          last?.type === "elicitation" || (task.status === "in_review" && last?.type === "response");
        if (!waitsForOwner && (last === null || now - last.at > KEEP_ALIVE_AFTER_MS)) {
          if (act) {
            await linear.postActivity(sessionId, "thought", KEEP_ALIVE_TEXT[task.status], true);
            await recordActivity(ctx, sessionId, now, "thought");
          }
          report.keptAlive++;
        }
      }
    } catch (error) {
      report.errors++;
      ctx.logger.error("Reconcile failed for a linked task", { companyId, taskId: task.id, error: String(error) });
    }
  }
  return report;
}
