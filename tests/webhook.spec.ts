import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkDelivery, firstDelivery, MAX_DELIVERY_AGE_MS, signatureMatches } from "../src/linear/webhook.js";

const secret = "whsec_test";
const now = 1_762_000_000_000;

function delivery(body: object, opts: { secret?: string; id?: string | null; headerCase?: "lower" | "title" } = {}) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", opts.secret ?? secret).update(rawBody).digest("hex");
  const title = opts.headerCase === "title";
  const headers: Record<string, string> = { [title ? "Linear-Signature" : "linear-signature"]: signature };
  if (opts.id !== null) headers[title ? "Linear-Delivery" : "linear-delivery"] = opts.id ?? "d-1";
  return { headers, rawBody };
}

describe("checkDelivery", () => {
  it("accepts a signed, fresh delivery and returns its id", () => {
    expect(checkDelivery(delivery({ webhookTimestamp: now - 1000 }, { headerCase: "title" }), secret, now)).toEqual({
      ok: true,
      deliveryId: "d-1",
    });
  });

  it("rejects a signature made with another secret", () => {
    expect(checkDelivery(delivery({ webhookTimestamp: now }, { secret: "other" }), secret, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a body changed after signing", () => {
    const d = delivery({ webhookTimestamp: now, action: "create" });
    expect(checkDelivery({ ...d, rawBody: d.rawBody.replace("create", "remove") }, secret, now).ok).toBe(false);
  });

  it("rejects deliveries older or newer than a minute", () => {
    for (const offset of [MAX_DELIVERY_AGE_MS + 1, -(MAX_DELIVERY_AGE_MS + 1)]) {
      expect(checkDelivery(delivery({ webhookTimestamp: now - offset }), secret, now)).toEqual({ ok: false, reason: "stale" });
    }
  });

  it("rejects a delivery without an id or a timestamp", () => {
    expect(checkDelivery(delivery({ webhookTimestamp: now }, { id: null }), secret, now).ok).toBe(false);
    expect(checkDelivery(delivery({}), secret, now)).toEqual({ ok: false, reason: "stale" });
  });

  it("treats a malformed signature as a mismatch", () => {
    expect(signatureMatches("{}", "not-hex", secret)).toBe(false);
    expect(signatureMatches("{}", undefined, secret)).toBe(false);
  });
});

describe("firstDelivery", () => {
  it("handles a retried delivery id once", async () => {
    const values = new Map<string, unknown>();
    const store = {
      get: async (k: { stateKey: string }) => values.get(k.stateKey) ?? null,
      set: async (k: { stateKey: string }, v: unknown) => void values.set(k.stateKey, v),
    };
    expect(await firstDelivery(store, "d-1", now)).toBe(true);
    expect(await firstDelivery(store, "d-1", now + 60_000)).toBe(false);
    expect(await firstDelivery(store, "d-2", now)).toBe(true);
  });
});
