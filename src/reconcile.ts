import type { PluginContext } from "@paperclipai/plugin-sdk";
import { organizationKey, type LinearConfig } from "./config.js";
import { handleAgentSessionEvent, ORIGIN_KIND, sessionKey, taskKey, wakeLead, type SessionLink } from "./intake.js";
import type { LinearApi } from "./linear/api.js";
import { commentOutbound, doneOutbound, moveIssue, outboundKey, readActivity, recordActivity } from "./status.js";

export const RECONCILE_JOB = "reconcile";

/** Linear marks a session stale after about 30 minutes without activity. */
export const KEEP_ALIVE_AFTER_MS = 20 * 60 * 1000;

/** Recover only sessions created within this time; older ones are a person's to look at. */
export const RECOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Leave a session this young to its webhook delivery, which can still be on its way. */
export const RECOVER_GRACE_MS = 2 * 60 * 1000;
/** The most sessions one run recovers for one company. */
export const RECOVER_LIMIT = 10;
/** How many of the app's newest sessions one run reads. */
export const RECOVER_PAGE = 50;
/** Session statuses that end a session: recovery does not start work for them. */
const ENDED_SESSION = new Set(["complete", "stopping"]);
/** Issue state types for which no work starts. */
const CLOSED_ISSUE = new Set(["completed", "canceled"]);

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
  recovered: number;
  /** Lost sessions found in observe mode; intake wrote nothing for them. */
  observed: number;
  superseded: number;
  errors: number;
}

/**
 * Bring one company's linked tasks back in line with Linear. Plugin events
 * arrive at most once, so this job replays what was missed: agent comments
 * and completion reports. It also cancels Paperclip tasks whose Linear issue
 * was canceled, wakes routed tasks whose first wake failed, and keeps the
 * sessions of open tasks from going stale, except where a question waits.
 * Last, it runs intake for the app's agent sessions that have no link: their
 * `created` delivery did not arrive or failed (DIL-992).
 */
export async function reconcileCompany(
  ctx: PluginContext,
  linear: LinearApi,
  companyId: string,
  config: LinearConfig,
  now: number,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checked: 0,
    cancelled: 0,
    commentsReplayed: 0,
    doneReported: 0,
    keptAlive: 0,
    woken: 0,
    recovered: 0,
    observed: 0,
    superseded: 0,
    errors: 0,
  };
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
            if (config.closeOnDone && config.states.done) await moveIssue(ctx, linear, link.linearIssueId, config.states.done);
          }
          report.doneReported++;
        }
      } else if (Object.hasOwn(KEEP_ALIVE_TEXT, task.status)) {
        const last = await readActivity(ctx, sessionId);
        // A question to the owner keeps its session in "Needs input" with no
        // help (probed), and a thought may replace that state.
        const waitsForOwner = last?.type === "elicitation";
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
  await recoverSessions(ctx, linear, companyId, config, now, tasks, report);
  return report;
}

/**
 * Run intake for the app's recent agent sessions that have no session link.
 * Intake is the same as for a `created` delivery, with the same session link
 * check, so a late delivery for a recovered session is a duplicate, and a
 * recovered session whose delivery was already handled is skipped. A session
 * is skipped when an open Paperclip task already exists for its Linear issue:
 * a later delegation of the same issue was routed. Only the company that the
 * webhook maps the Linear workspace to recovers its sessions, so two
 * companies on one workspace do not both start work.
 */
async function recoverSessions(
  ctx: PluginContext,
  linear: LinearApi,
  companyId: string,
  config: LinearConfig,
  now: number,
  tasks: Array<{ status: string; originId?: string | null }>,
  report: ReconcileReport,
): Promise<void> {
  if ((await ctx.state.get(organizationKey(config.linearOrganizationId))) !== companyId) return;
  let sessions;
  try {
    sessions = await linear.appAgentSessions(RECOVER_PAGE);
  } catch (error) {
    report.errors++;
    ctx.logger.error("Reconcile could not list Linear agent sessions", { companyId, error: String(error) });
    return;
  }
  const openIssues = new Set(
    tasks.filter((t) => t.status !== "done" && t.status !== "cancelled" && t.originId).map((t) => t.originId!),
  );
  for (const session of sessions) {
    if (report.recovered >= RECOVER_LIMIT) break;
    const ageMs = now - session.createdAt;
    if (!(ageMs >= RECOVER_GRACE_MS && ageMs <= RECOVER_WINDOW_MS)) continue;
    if (session.dismissed || ENDED_SESSION.has(session.status) || !session.issueId) continue;
    if (!session.delegatedToApp || CLOSED_ISSUE.has(session.issueStateType ?? "")) continue;
    if (await ctx.state.get(sessionKey(session.id))) continue;
    if (openIssues.has(session.issueId)) {
      report.superseded++;
      ctx.logger.debug("A newer delegation of the issue was routed; not recovering its lost session", { companyId, sessionId: session.id });
      continue;
    }
    try {
      const intake = await handleAgentSessionEvent(
        { ctx, linear, companyId, config },
        { action: "created", agentSession: { id: session.id, issueId: session.issueId, creatorId: session.creatorId ?? undefined } },
      );
      if (intake === "duplicate_session") continue;
      const outcome = intake === "observed" ? "observed" : "recovered";
      report[outcome]++;
      if (outcome === "recovered") openIssues.add(session.issueId);
      ctx.logger.info("Recovered a Linear agent session", { companyId, sessionId: session.id, ageMs, outcome, intake });
    } catch (error) {
      report.errors++;
      ctx.logger.error("Reconcile failed to recover a Linear agent session", {
        companyId,
        sessionId: session.id,
        ageMs,
        error: String(error),
      });
    }
  }
}
