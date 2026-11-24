import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import type { Fetch } from "../src/linear/api.js";
import { handleLinearWebhook, organizationKey, tokenSources, webhookSecrets } from "../src/worker.js";
import { companyId, config, created, fakeLinear } from "./fakes.js";

/** Linear drops a delivery that gets no answer within 5 seconds. */
const LINEAR_DEADLINE_MS = 5_000;
/** A slow round trip to the Linear API, so the test counts each call. */
const LINEAR_LATENCY_MS = 150;

/**
 * The SDK awaits onWebhook before the host answers Linear, so the plugin
 * cannot answer first and work later. The whole routed intake must fit in
 * the deadline. Half the deadline leaves room for a slow host.
 */
describe("webhook deadline", () => {
  it("routes an agent session within half of Linear's deadline", async () => {
    tokenSources.clear();
    webhookSecrets.clear();
    const harness = createTestHarness({ manifest, config: config("act") as unknown as Record<string, unknown> });
    harness.ctx.secrets.resolve = async () => "whsec_test";
    await harness.ctx.state.set(organizationKey("org-1"), companyId);
    const linear = fakeLinear({ labels: [], projectId: "lin-website" });
    let calls = 0;
    const slowFetch: Fetch = async (url, init) => {
      calls++;
      await new Promise((r) => setTimeout(r, LINEAR_LATENCY_MS));
      return linear.fetch(url, init);
    };

    const now = Date.now();
    const rawBody = JSON.stringify({ type: "AgentSessionEvent", organizationId: "org-1", ...created, webhookTimestamp: now });
    const input = {
      endpointKey: "linear",
      headers: { "linear-delivery": "d-1", "linear-signature": createHmac("sha256", "whsec_test").update(rawBody).digest("hex") },
      rawBody,
      parsedBody: JSON.parse(rawBody),
      requestId: "r-1",
    };
    const started = performance.now();
    expect(await handleLinearWebhook(harness.ctx, input, now, slowFetch)).toBe("accepted");
    const elapsed = performance.now() - started;

    const handled = harness.logs.find((l) => l.message === "Handled a Linear agent session event");
    expect(handled?.meta).toMatchObject({ outcome: "routed" });
    expect(calls).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(LINEAR_DEADLINE_MS / 2);
  });
});
