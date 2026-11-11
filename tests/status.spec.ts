import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { LinearConfig } from "../src/config.js";
import { handleAgentSessionEvent, sessionKey, type SessionLink } from "../src/intake.js";
import manifest from "../src/manifest.js";
import { handleStatusEvent } from "../src/status.js";
import { companyId, config, created, fakeLinear } from "./fakes.js";

let n = 0;
function event(eventType: string, payload: Record<string, unknown>, base: Partial<PluginEvent> = {}): PluginEvent {
  return { eventId: `evt-${++n}`, eventType: eventType as PluginEvent["eventType"], occurredAt: "2026-11-11T12:00:00Z", companyId, payload, ...base };
}

describe("status back to Linear", () => {
  let harness: ReturnType<typeof createTestHarness>;
  let linear: ReturnType<typeof fakeLinear>;
  let taskId: string;

  async function setup(cfg: LinearConfig) {
    harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issues.read"] });
    linear = fakeLinear({ labels: [], projectId: "lin-website" });
    await handleAgentSessionEvent({ ctx: harness.ctx, linear: linear.api, companyId, config: { ...cfg, mode: "act" } }, created);
    taskId = (harness.getState(sessionKey("sess-1")) as SessionLink).paperclipIssueId!;
    linear.activities.length = 0;
    return { ctx: harness.ctx, linear: linear.api, config: cfg, paperclipUrl: "https://paperclip.example" };
  }

  let deps: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    deps = await setup(config("act", { states: { started: "st-started", inReview: "st-review", done: "st-done" } }));
  });

  it("reports a run start and moves the issue to the started state", async () => {
    expect(await handleStatusEvent(deps, event("agent.run.started", { issueId: taskId }))).toBe("reported");
    expect(linear.activities).toEqual([expect.objectContaining({ type: "thought" })]);
    expect(linear.stateMoves).toEqual([{ id: "lin-issue-1", stateId: "st-started" }]);
  });

  it("posts an agent's comment as a response and attaches pull request links", async () => {
    const body = "Opened https://github.com/acme/site/pull/42 for review.";
    const comment = await harness.ctx.issues.createComment(taskId, body, companyId);
    const e = event("issue.comment.created", { commentId: comment.id }, { entityId: taskId, entityType: "issue", actorType: "agent" });
    expect(await handleStatusEvent(deps, e)).toBe("reported");
    expect(linear.activities).toEqual([{ type: "response", body }]);
    expect(linear.urls).toEqual([{ label: "Pull request", url: "https://github.com/acme/site/pull/42" }]);
  });

  it("does not echo the plugin's own or people's comments", async () => {
    const comment = await harness.ctx.issues.createComment(taskId, "From Linear: hi", companyId);
    for (const actorType of ["plugin", "user"] as const) {
      const e = event("issue.comment.created", { commentId: comment.id }, { entityId: taskId, actorType });
      expect(await handleStatusEvent(deps, e)).toBe("skipped");
    }
    expect(linear.activities).toEqual([]);
  });

  it("reports a failed run as an error with a link to Paperclip", async () => {
    await handleStatusEvent(deps, event("agent.run.failed", { issueId: taskId, error: "budget exhausted" }));
    expect(linear.activities[0].type).toBe("error");
    expect(linear.activities[0].body).toContain("budget exhausted");
    expect(linear.activities[0].body).toContain(`https://paperclip.example/issues/${taskId}`);
  });

  it("asks in Linear when an approval is waiting", async () => {
    await handleStatusEvent(deps, event("approval.created", { issueId: taskId }));
    expect(linear.activities).toEqual([expect.objectContaining({ type: "elicitation" })]);
  });

  it("moves to review, and reports done without closing unless allowed", async () => {
    await handleStatusEvent(deps, event("issue.updated", { status: "in_review" }, { entityId: taskId }));
    await handleStatusEvent(deps, event("issue.updated", { status: "done" }, { entityId: taskId }));
    expect(linear.stateMoves).toEqual([{ id: "lin-issue-1", stateId: "st-review" }]);
    expect(linear.activities).toEqual([{ type: "response", body: "Finished in Paperclip." }]);
  });

  it("closes the Linear issue on done when configured", async () => {
    deps = await setup(config("act", { states: { done: "st-done" }, closeOnDone: true }));
    await handleStatusEvent(deps, event("issue.updated", { status: "done" }, { entityId: taskId }));
    expect(linear.stateMoves).toEqual([{ id: "lin-issue-1", stateId: "st-done" }]);
  });

  it("writes once per event, and nothing for unlinked tasks or in observe mode", async () => {
    const e = event("agent.run.failed", { issueId: taskId, error: "x" });
    expect(await handleStatusEvent(deps, e)).toBe("reported");
    expect(await handleStatusEvent(deps, e)).toBe("duplicate");
    expect(await handleStatusEvent(deps, event("agent.run.failed", { issueId: "other-task" }))).toBe("unlinked");
    expect(await handleStatusEvent({ ...deps, config: config("observe") }, event("agent.run.started", { issueId: taskId }))).toBe("observed");
    expect(linear.activities).toHaveLength(1);
  });
});
