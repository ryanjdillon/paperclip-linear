import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { COMPANIES_KEY } from "../src/reconcile.js";
import { MIN_REFRESH_INTERVAL_MS } from "../src/secret-cache.js";
import plugin, { handleLinearWebhook, organizationKey, webhookSecrets } from "../src/worker.js";

const companyId = "company-1";
const orgId = "linear-org-1";
const secretRef = { type: "secret_ref", secretId: "secret-1" } as const;
const config = {
  linearOrganizationId: orgId,
  webhookSecret: secretRef,
  linearClientId: "client-1",
  linearClientSecret: { type: "secret_ref", secretId: "secret-2" },
  mode: "observe",
  routing: { leads: { delivery: { paperclipProjectId: "p1", agentId: "a1" } }, projects: { "lin-p1": "delivery" } },
};
const now = 1_762_000_000_000;
/** An agent session event the plugin acts on. */
const session = { type: "AgentSessionEvent", action: "created" };

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
    expect(manifest.jobs?.map((j) => [j.jobKey, j.schedule])).toEqual([["reconcile", "*/5 * * * *"]]);
    for (const capability of ["webhooks.receive", "secrets.read-ref", "plugin.state.read", "plugin.state.write", "jobs.schedule"]) {
      expect(manifest.capabilities).toContain(capability);
    }
  });
});

describe("Linear webhook handling", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(async () => {
    webhookSecrets.clear();
    harness = createTestHarness({ manifest, config });
    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onConfigChanged?.(config, { companyId });
  });

  it("maps the configured Linear workspace to its company and registers the company for reconcile", () => {
    expect(harness.getState(organizationKey(orgId))).toBe(companyId);
    expect(harness.getState(COMPANIES_KEY)).toEqual([companyId]);
  });

  it("accepts a signed delivery once and drops the retry", async () => {
    const body = { organizationId: orgId, ...session, webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body), now)).toBe("accepted");
    expect(await handleLinearWebhook(harness.ctx, delivery(body), now)).toBe("duplicate");
  });

  it("rejects a forged signature without throwing", async () => {
    const body = { organizationId: orgId, ...session, webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body, "d-2", "wrong"), now)).toBe("rejected");
  });

  it("ignores deliveries for a workspace no company is configured for", async () => {
    const body = { organizationId: "someone-else", ...session, webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body), now)).toBe("unknown_organization");
  });

  it("ignores issue and comment deliveries without resolving the secret", async () => {
    let resolves = 0;
    const resolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (...args) => {
      resolves++;
      return resolve(...args);
    };
    const bodies = [
      { type: "Issue", action: "remove" },
      { type: "Comment", action: "create" },
      { type: "AgentSessionEvent", action: "unknown" },
      { action: "created" },
    ];
    for (const [i, body] of bodies.entries()) {
      const d = delivery({ organizationId: orgId, ...body, webhookTimestamp: now }, `d-${i}`);
      expect(await handleLinearWebhook(harness.ctx, d, now)).toBe("ignored_type");
      expect(harness.getState({ scopeKind: "instance", stateKey: `linear-delivery:d-${i}` })).toBeUndefined();
    }
    expect(resolves).toBe(0);
  });

  it("resolves the signing secret once for a burst of agent session deliveries", async () => {
    let resolves = 0;
    const resolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (...args) => {
      resolves++;
      return resolve(...args);
    };
    const prompted = { organizationId: orgId, type: "AgentSessionEvent", action: "prompted", webhookTimestamp: now };
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, i) => handleLinearWebhook(harness.ctx, delivery(prompted, `burst-${i}`), now)),
    );
    expect(new Set(outcomes)).toEqual(new Set(["accepted"]));
    expect(resolves).toBe(1);
  });

  it("accepts deliveries signed with a rotated secret and limits re-resolves for forgeries", async () => {
    let current = "old-secret";
    let resolves = 0;
    harness.ctx.secrets.resolve = async () => {
      resolves++;
      return current;
    };
    const body = { organizationId: orgId, ...session, webhookTimestamp: now };
    expect(await handleLinearWebhook(harness.ctx, delivery(body, "r-1", "old-secret"), now)).toBe("accepted");
    current = "new-secret";
    // The cache still holds the old value; the mismatch forces one re-resolve.
    vi.useFakeTimers({ now: Date.now() + MIN_REFRESH_INTERVAL_MS, toFake: ["Date"] });
    try {
      expect(await handleLinearWebhook(harness.ctx, delivery(body, "r-2", "new-secret"), now)).toBe("accepted");
      expect(resolves).toBe(2);
      for (let i = 0; i < 20; i++) {
        expect(await handleLinearWebhook(harness.ctx, delivery(body, `f-${i}`, "forged"), now)).toBe("rejected");
      }
      expect(resolves).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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
      expect.arrayContaining([
        "linearOrganizationId is required",
        "webhookSecret must be a secret reference",
        "linearClientId is required",
        "linearClientSecret must be a secret reference",
        "project x routes to unknown lead nobody",
      ]),
    );
  });
});
