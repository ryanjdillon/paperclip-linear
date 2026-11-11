import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { LinearConfig } from "./config.js";
import { ORIGIN_KIND, sessionKey, taskKey, type SessionLink } from "./intake.js";
import type { LinearApi } from "./linear/api.js";
import { commentOutbound, doneOutbound, lastActivityKey, outboundKey } from "./status.js";

export const RECONCILE_JOB = "reconcile";

/** Linear marks a session stale after about 30 minutes without activity. */
export const KEEP_ALIVE_AFTER_MS = 20 * 60 * 1000;

/** Instance state listing the companies the plugin is configured for; jobs carry no company. */
export const COMPANIES_KEY = { scopeKind: "instance", stateKey: "linear-companies" } as const;

export interface ReconcileReport {
  checked: number;
  cancelled: number;
  commentsReplayed: number;
  doneReported: number;
  keptAlive: number;
  errors: number;
}

/**
 * Bring one company's linked tasks back in line with Linear. Plugin events
 * arrive at most once, so this job replays what was missed: agent comments
 * and completion reports. It also cancels Paperclip tasks whose Linear issue
 * was canceled, and keeps sessions with work in progress from going stale.
 */
export async function reconcileCompany(
  ctx: PluginContext,
  linear: LinearApi,
  companyId: string,
  config: LinearConfig,
  now: number,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, cancelled: 0, commentsReplayed: 0, doneReported: 0, keptAlive: 0, errors: 0 };
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

      const comments = await ctx.issues.listComments(task.id, companyId);
      for (const comment of comments) {
        if (comment.authorType !== "agent" || !comment.body) continue;
        const key = outboundKey(commentOutbound(comment.id));
        if ((await ctx.state.get(key)) !== null) continue;
        if (act) {
          await ctx.state.set(key, { at: new Date(now).toISOString(), sessionId, replayed: true });
          await linear.postActivity(sessionId, "response", comment.body);
        }
        report.commentsReplayed++;
      }

      if (task.status === "done") {
        const key = outboundKey(doneOutbound(task.id));
        if ((await ctx.state.get(key)) === null) {
          if (act) {
            await ctx.state.set(key, { at: new Date(now).toISOString(), sessionId, replayed: true });
            await linear.postActivity(sessionId, "response", "Finished in Paperclip.");
            if (config.closeOnDone && config.states.done) await linear.setIssueState(link.linearIssueId, config.states.done);
          }
          report.doneReported++;
        }
      } else if (task.status === "in_progress") {
        const last = (await ctx.state.get(lastActivityKey(sessionId))) as number | null;
        if (last === null || now - last > KEEP_ALIVE_AFTER_MS) {
          if (act) {
            await linear.postActivity(sessionId, "thought", "Still working on it in Paperclip.", true);
            await ctx.state.set(lastActivityKey(sessionId), now);
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
