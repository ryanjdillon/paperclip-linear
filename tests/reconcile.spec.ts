import { beforeEach, describe, expect, it } from "vitest";
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

  it("changes nothing in observe mode but still reports what it found", async () => {
    await harness.ctx.issues.update(taskId, { status: "done" }, companyId);
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, config("observe"), Date.now());
    expect(report.doneReported).toBe(1);
    expect(linear.activities).toEqual([]);
  });
});
