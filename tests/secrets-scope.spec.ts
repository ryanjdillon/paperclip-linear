import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { handleAgentSessionEvent } from "../src/intake.js";
import { COMPANIES_KEY } from "../src/reconcile.js";
import { handleLinearWebhook, organizationKey, runReconcile, tokenSources } from "../src/worker.js";
import { companyId, config, created, fakeLinear } from "./fakes.js";

const webhookSecret = "whsec_test";
const clientSecret = "client-secret";

/**
 * Paperclip (checked in 2026.1117.0) runs webhooks and jobs outside any company invocation,
 * so `secrets.resolve` is refused ("company context is required") unless the
 * call names the company. This fake host enforces the same rule.
 */
function strictSecrets(ctx: PluginContext, calls: Array<{ companyId?: string; configPath?: string }>) {
  ctx.secrets.resolve = async (ref, options = {}) => {
    calls.push(options);
    if (options.companyId !== companyId) throw new Error('not allowed to perform "secrets.resolve": company context is required');
    const id = typeof ref === "string" ? ref : ref.secretId;
    return id === "s1" ? webhookSecret : clientSecret;
  };
}

function signedDelivery(body: object, now: number) {
  const rawBody = JSON.stringify({ ...body, webhookTimestamp: now });
  const signature = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return {
    endpointKey: "linear",
    headers: { "linear-signature": signature, "linear-delivery": "d-1" },
    rawBody,
    parsedBody: JSON.parse(rawBody),
    requestId: "r-1",
  };
}

describe("secret resolution names the company", () => {
  let harness: ReturnType<typeof createTestHarness>;
  let calls: Array<{ companyId?: string; configPath?: string }>;

  beforeEach(async () => {
    harness = createTestHarness({ manifest, config: config("observe") as unknown as Record<string, unknown> });
    calls = [];
    tokenSources.clear();
    strictSecrets(harness.ctx, calls);
    await harness.ctx.state.set(organizationKey("org-1"), companyId);
    await harness.ctx.state.set(COMPANIES_KEY, [companyId]);
  });

  it("accepts a signed webhook delivery outside a company invocation", async () => {
    const now = Date.now();
    const outcome = await handleLinearWebhook(
      harness.ctx,
      signedDelivery({ type: "AgentSessionEvent", action: "created", organizationId: "org-1" }, now),
      now,
      fakeLinear({ labels: [], projectId: null }).fetch,
    );
    expect(outcome).toBe("accepted");
    expect(calls).toContainEqual({ companyId, configPath: "webhookSecret" });
  });

  it("handles an agent session delivery through intake, minting with the company", async () => {
    harness.setConfig(config("act") as unknown as Record<string, unknown>);
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    const now = Date.now();
    const outcome = await handleLinearWebhook(
      harness.ctx,
      signedDelivery({ type: "AgentSessionEvent", organizationId: "org-1", ...created }, now),
      now,
      linear.fetch,
    );
    expect(outcome).toBe("accepted");
    expect(calls).toContainEqual({ companyId, configPath: "linearClientSecret" });
    expect(harness.logs.filter((l) => l.message === "Failed to handle a Linear agent session event")).toEqual([]);
    expect(harness.logs.some((l) => l.message === "Handled a Linear agent session event")).toBe(true);
  });

  it("resolves the client secret for the reconcile job with the company", async () => {
    // A linked session gives the reconcile something to check in Linear.
    harness.setConfig(config("act") as unknown as Record<string, unknown>);
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    await handleAgentSessionEvent({ ctx: harness.ctx, linear: linear.api, companyId, config: config("act") }, created);
    await runReconcile(harness.ctx, Date.now(), linear.fetch);
    expect(calls).toContainEqual({ companyId, configPath: "linearClientSecret" });
    expect(harness.logs.filter((l) => l.message === "Reconcile failed for a company")).toEqual([]);
  });
});
