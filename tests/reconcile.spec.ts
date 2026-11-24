import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { handleAgentSessionEvent, ORIGIN_KIND, sessionKey, type SessionLink } from "../src/intake.js";
import manifest from "../src/manifest.js";
import { KEEP_ALIVE_AFTER_MS, RECOVER_GRACE_MS, RECOVER_LIMIT, RECOVER_WINDOW_MS, reconcileCompany } from "../src/reconcile.js";
import { handleStatusEvent, lastActivityKey, readActivity, recordActivity } from "../src/status.js";
import { appSession, companyId, config, created, fakeLinear } from "./fakes.js";

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

  it("reports a missed completion but does not close an issue in another team", async () => {
    linear.issue.teamId = "team-other";
    await harness.ctx.issues.update(taskId, { status: "done" }, companyId);
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report).toMatchObject({ doneReported: 1, errors: 0 });
    expect(linear.activities).toEqual([{ type: "response", body: "Finished in Paperclip." }]);
    expect(linear.stateMoves).toEqual([]);
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

  describe("keep-alive while work waits", () => {
    const quiet = KEEP_ALIVE_AFTER_MS + 1;

    async function quietFor(status: string, type: "thought" | "elicitation" | "response", at: number) {
      await harness.ctx.issues.update(taskId, { status } as never, companyId);
      await recordActivity(harness.ctx, "sess-1", at, type);
    }

    it.each([
      ["backlog", "Waiting in the Paperclip backlog."],
      ["todo", "Queued in Paperclip."],
      ["in_progress", "Still working on it in Paperclip."],
      ["blocked", "Blocked in Paperclip until another task finishes."],
      ["in_review", "Waiting for review in Paperclip."],
    ])("keeps a quiet %s task's session alive", async (status, text) => {
      const now = Date.now();
      await quietFor(status, "thought", now - quiet);
      expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).keptAlive).toBe(1);
      expect(linear.activities).toEqual([expect.objectContaining({ type: "thought", body: text })]);
      expect(await readActivity(harness.ctx, "sess-1")).toEqual({ at: now, type: "thought" });
    });

    it("never posts over a question to the owner, however long it waits", async () => {
      await harness.ctx.issues.update(taskId, { status: "in_progress" }, companyId);
      const asked = Date.parse("2026-11-11T12:00:00Z");
      await handleStatusEvent(
        { ctx: harness.ctx, linear: linear.api, config: cfg },
        { eventId: "evt-approval", eventType: "approval.created", occurredAt: new Date(asked).toISOString(), companyId, payload: { issueId: taskId } } as never,
      );
      expect((await readActivity(harness.ctx, "sess-1"))?.type).toBe("elicitation");
      linear.activities.length = 0;

      const weekLater = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, weekLater)).keptAlive).toBe(0);
      expect(linear.activities).toEqual([]);
    });

    it("keeps a task in review alive after the agent's answer", async () => {
      const now = Date.now();
      await quietFor("in_review", "response", now - quiet);
      expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).keptAlive).toBe(1);
    });

    it.each([
      ["the agent's run starts", "agent.run.started"],
      ["the agent answers", "issue.comment.created"],
    ])("resumes the keep-alive after a question when %s", async (_, eventType) => {
      await harness.ctx.issues.update(taskId, { status: "in_progress" }, companyId);
      await recordActivity(harness.ctx, "sess-1", 0, "elicitation");
      if (eventType === "issue.comment.created") {
        await harness.ctx.issues.createComment(taskId, "Approved, carrying on", companyId, { authorAgentId: "agent-delivery" });
      }
      const at = Date.parse("2026-11-11T12:00:00Z");
      await handleStatusEvent(
        { ctx: harness.ctx, linear: linear.api, config: cfg },
        { eventId: `evt-${eventType}`, eventType, occurredAt: new Date(at).toISOString(), companyId, actorType: "agent", entityId: taskId, payload: { issueId: taskId } } as never,
      );
      expect((await readActivity(harness.ctx, "sess-1"))?.type).not.toBe("elicitation");
      expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now() + quiet)).keptAlive).toBe(1);
    });

    it("records a post even when a later step of the same event fails", async () => {
      await recordActivity(harness.ctx, "sess-1", 0, "elicitation");
      vi.spyOn(linear.api, "setIssueState").mockRejectedValueOnce(new Error("Linear unavailable"));
      await expect(
        handleStatusEvent(
          { ctx: harness.ctx, linear: linear.api, config: config("act", { states: { started: "st-started" } }) },
          { eventId: "evt-start-fail", eventType: "agent.run.started", occurredAt: new Date().toISOString(), companyId, payload: { issueId: taskId } } as never,
        ),
      ).rejects.toThrow();
      expect((await readActivity(harness.ctx, "sess-1"))?.type).toBe("thought");
    });

    it("keeps alive a session with a time-only record from an older version", async () => {
      const now = Date.now();
      await harness.ctx.issues.update(taskId, { status: "todo" }, companyId);
      await harness.ctx.state.set(lastActivityKey("sess-1"), now - quiet);
      expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).keptAlive).toBe(1);
    });

    it("keeps working after an answer while the task is still in progress", async () => {
      const now = Date.now();
      await quietFor("in_progress", "response", now - quiet);
      expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).keptAlive).toBe(1);
    });

    it("reads a time-only record from an older version as a thought", async () => {
      const now = Date.now();
      await harness.ctx.state.set(lastActivityKey("sess-1"), now - quiet);
      expect(await readActivity(harness.ctx, "sess-1")).toEqual({ at: now - quiet, type: "thought" });
    });
  });

  it("changes nothing in observe mode but still reports what it found", async () => {
    await harness.ctx.issues.update(taskId, { status: "done" }, companyId);
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, config("observe"), Date.now());
    expect(report.doneReported).toBe(1);
    expect(linear.activities).toEqual([]);
  });

  it("does not recover a session whose delivery was handled", async () => {
    linear.sessions.push(appSession("sess-1", Date.now(), 10 * 60 * 1000));
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report).toMatchObject({ recovered: 0, superseded: 0, errors: 0 });
    expect(linear.activities).toEqual([]);
  });

  it("does not recover a lost session when the issue already has an open task", async () => {
    // The owner delegated the issue again, and that delivery was routed.
    linear.sessions.push(appSession("sess-lost", Date.now(), 10 * 60 * 1000));
    const report = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now());
    expect(report).toMatchObject({ recovered: 0, superseded: 1 });
    expect(harness.getState(sessionKey("sess-lost"))).toBeUndefined();
    expect(await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND })).toHaveLength(1);
  });
});

describe("reconcile recovers lost agent sessions", () => {
  const cfg = config();
  const minutes = (n: number) => n * 60 * 1000;
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness({ manifest });
  });

  const tasks = () => harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND });

  it("runs intake for a session whose created delivery was lost, once", async () => {
    const now = Date.now();
    const linear = fakeLinear({ labels: [], projectId: "lin-website" }, [appSession("sess-lost", now, minutes(10))]);

    const first = await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now);
    expect(first).toMatchObject({ recovered: 1, errors: 0 });
    const [task] = await tasks();
    expect(task).toMatchObject({ assigneeAgentId: "agent-delivery", originId: "lin-issue-1", status: "todo" });
    expect(harness.getState(sessionKey("sess-lost"))).toMatchObject({ status: "routed", paperclipIssueId: task.id, delegatedBy: "user-ryan" });
    expect((harness.getState(sessionKey("sess-lost")) as SessionLink).wokenAt).toBeDefined();
    expect(linear.activities.map((a) => a.type)).toEqual(["thought", "thought"]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ level: "info", meta: expect.objectContaining({ sessionId: "sess-lost", outcome: "recovered", intake: "routed" }) }),
    );

    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now + minutes(5))).recovered).toBe(0);
    expect(await tasks()).toHaveLength(1);
  });

  it("treats a late delivery for a recovered session as a duplicate", async () => {
    const now = Date.now();
    const linear = fakeLinear({ labels: [], projectId: "lin-website" }, [appSession("sess-1", now, minutes(10))]);
    await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now);
    expect(await handleAgentSessionEvent({ ctx: harness.ctx, linear: linear.api, companyId, config: cfg }, created)).toBe("duplicate_session");
    expect(await tasks()).toHaveLength(1);
  });

  it("creates one task when the delivery arrives while reconcile recovers the session", async () => {
    const now = Date.now();
    const linear = fakeLinear({ labels: [], projectId: "lin-website" }, [appSession("sess-1", now, minutes(10))]);
    const deps = { ctx: harness.ctx, linear: linear.api, companyId, config: cfg };
    const [report, outcome] = await Promise.all([
      reconcileCompany(harness.ctx, linear.api, companyId, cfg, now),
      handleAgentSessionEvent(deps, created),
    ]);
    expect(await tasks()).toHaveLength(1);
    expect(report.recovered + (outcome === "routed" ? 1 : 0)).toBe(1);
  });

  it("asks which lead for a recovered session that matches no route", async () => {
    const now = Date.now();
    const linear = fakeLinear({ labels: [], projectId: null }, [appSession("sess-lost", now, minutes(10))]);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).recovered).toBe(1);
    expect((harness.getState(sessionKey("sess-lost")) as SessionLink).status).toBe("awaiting_route");
    expect(linear.activities.at(-1)).toMatchObject({ type: "elicitation" });
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now + minutes(5))).recovered).toBe(0);
  });

  it.each([
    ["a session of another app", (now: number) => appSession("s", now, minutes(10), { appUser: { id: "other-app" } })],
    ["a dismissed session", (now: number) => appSession("s", now, minutes(10), { dismissedAt: new Date(now).toISOString() })],
    ["a session with no issue", (now: number) => appSession("s", now, minutes(10), { issue: null })],
    ["a session whose delivery can still arrive", (now: number) => appSession("s", now, RECOVER_GRACE_MS - 1)],
    ["a session older than the window", (now: number) => appSession("s", now, RECOVER_WINDOW_MS + 1)],
  ])("does not recover %s", async (_, session) => {
    const now = Date.now();
    const linear = fakeLinear({ labels: [], projectId: "lin-website" }, [session(now)]);
    expect(await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).toMatchObject({ recovered: 0, errors: 0 });
    expect(await tasks()).toEqual([]);
    expect(linear.activities).toEqual([]);
  });

  it("recovers at most the limit in one run, and the rest in the next", async () => {
    const now = Date.now();
    const sessions = Array.from({ length: RECOVER_LIMIT + 2 }, (_, i) =>
      appSession(`sess-${i}`, now, minutes(10 + i), { issue: { id: `lin-issue-${i}` } }),
    );
    const linear = fakeLinear({ labels: [], projectId: "lin-website" }, sessions);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).recovered).toBe(RECOVER_LIMIT);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, cfg, now)).recovered).toBe(2);
  });

  it("writes nothing in observe mode but reports the session", async () => {
    const now = Date.now();
    const linear = fakeLinear({ labels: [], projectId: "lin-website" }, [appSession("sess-lost", now, minutes(10))]);
    expect((await reconcileCompany(harness.ctx, linear.api, companyId, config("observe"), now)).recovered).toBe(1);
    expect(await tasks()).toEqual([]);
    expect(linear.activities).toEqual([]);
    expect(harness.getState(sessionKey("sess-lost"))).toBeUndefined();
  });

  it("counts an error when Linear cannot list the sessions", async () => {
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    vi.spyOn(linear.api, "appAgentSessions").mockRejectedValueOnce(new Error("Linear unavailable"));
    expect(await reconcileCompany(harness.ctx, linear.api, companyId, cfg, Date.now())).toMatchObject({ recovered: 0, errors: 1 });
  });
});
