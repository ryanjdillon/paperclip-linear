import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { handleAgentSessionEvent, sessionKey, type SessionLink } from "../src/intake.js";
import manifest from "../src/manifest.js";
import { KEEP_ALIVE_AFTER_MS, reconcileCompany } from "../src/reconcile.js";
import { handleStatusEvent, lastActivityKey } from "../src/status.js";
import { companyId, config, created, fakeLinear } from "./fakes.js";

describe("reconcile", () => {
  let harness: ReturnType<typeof createTestHarness>;
  let linear: ReturnType<typeof fakeLinear>;
  let taskId: string;
  const cfg = config("act", { states: { done: "st-done" }, closeOnDone: true });

  beforeEach(async () => {
    harness = createTestHarness({ manifest });
    linear = fakeLinear({ labels: [], projectId: "lin-website" });
    await handleAgentSessionEvent({ ctx: harness.ctx, linear: linear.api, companyId, config: cfg }, created);
    taskId = (harness.getState(sessionKey("sess-1")) as SessionLink).paperclipIssueId!;
    linear.activities.length = 0;
  });

  it("replays an agent comment whose event was missed, once", async () => {
    await harness.ctx.issues.createComment(taskId, "Done, see https://github.com/a/b/pull/1", companyId, { authorAgentId: "agent-delivery" });
    await harness.ctx.issues.createComment(taskId, "From Linear: plugin import", companyId);
    const first = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    const second = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(first.commentsReplayed).toBe(1);
    expect(second.commentsReplayed).toBe(0);
    expect(linear.activities.filter((a) => a.type === "response")).toHaveLength(1);
  });

  it("does not replay a comment the event handler already reported", async () => {
    const comment = await harness.ctx.issues.createComment(taskId, "Progress update", companyId, { authorAgentId: "agent-delivery" });
    await handleStatusEvent(
      { ctx: harness.ctx, linear: linear.api, config: cfg },
      { eventId: "e1", eventType: "issue.comment.created", occurredAt: new Date().toISOString(), companyId, entityId: taskId, actorType: "agent", payload: { commentId: comment.id } },
    );
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now())).commentsReplayed).toBe(0);
  });

  it("reports a missed completion and closes the issue when configured", async () => {
    await harness.ctx.issues.update(taskId, { status: "done" }, companyId);
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report.doneReported).toBe(1);
    expect(linear.stateMoves).toEqual([{ id: "lin-issue-1", stateId: "st-done" }]);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now())).doneReported).toBe(0);
  });

  it("cancels the Paperclip task when the Linear issue was canceled", async () => {
    linear.issue.stateType = "canceled";
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report.cancelled).toBe(1);
    expect((await harness.ctx.issues.get(taskId, companyId))?.status).toBe("cancelled");
  });

  it("keeps a quiet session with work in progress alive", async () => {
    await harness.ctx.issues.update(taskId, { status: "in_progress" }, companyId);
    const now = Date.now();
    await harness.ctx.state.set(lastActivityKey("sess-1"), now - KEEP_ALIVE_AFTER_MS - 1);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).keptAlive).toBe(1);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now + 1000)).keptAlive).toBe(0);
  });

  it("wakes a routed task whose first wake failed, once", async () => {
    // As the server leaves it when the wake is refused: in backlog, with no wake record.
    await harness.ctx.issues.update(taskId, { status: "backlog" }, companyId);
    const { wokenAt: _, ...link } = harness.getState(sessionKey("sess-1")) as SessionLink;
    await harness.ctx.state.set(sessionKey("sess-1"), link);

    const now = Date.now();
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).woken).toBe(1);
    expect((await harness.ctx.issues.get(taskId, companyId))?.status).toBe("todo");
    expect(harness.getState(sessionKey("sess-1"))).toMatchObject({ wokenAt: new Date(now).toISOString() });
    expect(linear.activities.map((a) => a.type)).toEqual(["thought"]);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now + 1000)).woken).toBe(0);
  });

  it("retries a wake that failed at intake, after the task was already todo", async () => {
    const fresh = createTestHarness({ manifest });
    const wake = vi.spyOn(fresh.ctx.issues, "requestWakeup").mockRejectedValueOnce(new Error("host unavailable"));
    await expect(handleAgentSessionEvent({ ctx: fresh.ctx, linear: linear.api, companyId, config: cfg }, created)).rejects.toThrow();
    const link = fresh.getState(sessionKey("sess-1")) as SessionLink;
    expect(link.wokenAt).toBeUndefined();
    expect((await fresh.ctx.issues.get(link.paperclipIssueId!, companyId))?.status).toBe("todo");

    expect((await reconcileCompany(fresh.ctx, linear.api, companyId, cfg, Date.now())).woken).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[1][2]?.idempotencyKey).not.toBe(wake.mock.calls[0][2]?.idempotencyKey);
    expect((fresh.getState(sessionKey("sess-1")) as SessionLink).wokenAt).toBeDefined();
  });

  it("does not record a wake that the server did not queue, and retries it", async () => {
    const { wokenAt: _, ...link } = harness.getState(sessionKey("sess-1")) as SessionLink;
    await harness.ctx.state.set(sessionKey("sess-1"), link);
    const wake = vi.spyOn(harness.ctx.issues, "requestWakeup").mockResolvedValueOnce({ queued: false } as never);

    const now = Date.now();
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).woken).toBe(1);
    expect((harness.getState(sessionKey("sess-1")) as SessionLink).wokenAt).toBeUndefined();
    expect(linear.activities).toEqual([]);

    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now + 1000)).woken).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect((harness.getState(sessionKey("sess-1")) as SessionLink).wokenAt).toBeDefined();
  });

  it("cancels an unwoken backlog task whose Linear issue was canceled, rather than waking it", async () => {
    await harness.ctx.issues.update(taskId, { status: "backlog" }, companyId);
    const { wokenAt: _, ...link } = harness.getState(sessionKey("sess-1")) as SessionLink;
    await harness.ctx.state.set(sessionKey("sess-1"), link);
    linear.issue.stateType = "canceled";
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report).toMatchObject({ cancelled: 1, woken: 0 });
    expect((await harness.ctx.issues.get(taskId, companyId))?.status).toBe("cancelled");
  });

  it("leaves a woken task that the owner moved to backlog", async () => {
    await harness.ctx.issues.update(taskId, { status: "backlog" }, companyId);
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report.woken).toBe(0);
    expect((await harness.ctx.issues.get(taskId, companyId))?.status).toBe("backlog");
  });

  it("changes nothing in observe mode but still reports what it found", async () => {
    await harness.ctx.issues.update(taskId, { status: "done" }, companyId);
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, config("observe"), Date.now());
    expect(report.doneReported).toBe(1);
    expect(linear.activities).toEqual([]);
  });
});
