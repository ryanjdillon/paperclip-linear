import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { handleLinearWebhook, organizationKey } from "../src/worker.js";

const companyId = "company-1";
const orgId = "linear-org-1";
const secretRef = { type: "secret_ref", secretId: "secret-1" } as const;
const config = {
  linearOrganizationId: orgId,
  webhookSecret: secretRef,
  mode: "observe",
  routing: { leads: { delivery: { paperclipProjectId: "p1", agentId: "a1" } }, projects: { "lin-p1": "delivery" } },
};
const now = 1_762_000_000_000;

/** The test harness resolves a secret ref to `resolved:<ref>`. */
const harnessSecret = `resolved:${String(secretRef)}`;

function delivery(body: Record<string, unknown>, id = "d-1", secret = harnessSecret) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: "linear",
    headers: {
      "linear-delivery": id,
      "linear-signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
    rawBody,
    parsedBody: body,
    requestId: "req-1",
  };
}

describe("manifest", () => {
  it("declares the Linear webhook and the capabilities it needs", () => {
    expect(manifest.webhooks?.map((w) => w.endpointKey)).toEqual(["linear"]);
    for (const capability of ["webhooks.receive", "secrets.read-ref", "plugin.state.read", "plugin.state.write"]) {
      expect(manifest.capabilities).toContain(capability);
    }
  });
});

describe("Linear webhook handling", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(async () => {
    harness = createTestHarness({ manifest, config });
    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onConfigChanged?.(config, { companyId });
  });

  it("maps the configured Linear workspace to its company", () => {
    expect(harness.getState(organizationKey(orgId))).toBe(companyId);
  });

  it("accepts a signed delivery once and drops the retry", async () => {
    const body = { organizationId: orgId, type: "AgentSessionEvent", webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body), now)).toBe("accepted");
    expect(await handleLinearWebhook(harness.ctx, delivery(body), now)).toBe("duplicate");
  });

  it("rejects a forged signature without throwing", async () => {
    const body = { organizationId: orgId, webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body, "d-2", "wrong"), now)).toBe("rejected");
  });

  it("ignores deliveries for a workspace no company is configured for", async () => {
    const body = { organizationId: "someone-else", webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body), now)).toBe("unknown_organization");
  });

  it("ignores other endpoints", async () => {
    expect(await handleLinearWebhook(harness.ctx, { ...delivery({}), endpointKey: "other" }, now)).toBe("ignored_endpoint");
  });
});

describe("config validation", () => {
  it("accepts a complete config and reports what is missing", async () => {
    expect(await plugin.definition.onValidateConfig?.(config)).toEqual({ ok: true });
    const result = await plugin.definition.onValidateConfig?.({ routing: { leads: {}, projects: { x: "nobody" } } });
    expect(result?.ok).toBe(false);
    expect(result?.errors).toEqual(
      expect.arrayContaining(["linearOrganizationId is required", "webhookSecret must be a secret reference", "project x routes to unknown lead nobody"]),
    );
  });
});
