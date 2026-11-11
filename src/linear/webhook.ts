import { createHmac, timingSafeEqual } from "node:crypto";

/** Linear rejects nothing older than this; neither do we accept it. */
export const MAX_DELIVERY_AGE_MS = 60_000;

export type DeliveryCheck =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: "missing_delivery_id" | "bad_signature" | "stale" | "bad_body" };

/** Read a header case-insensitively; repeated headers take the first value. */
export function header(headers: Record<string, string | string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** Linear signs the raw body with HMAC-SHA256 and sends it hex-encoded in `Linear-Signature`. */
export function signatureMatches(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Check one delivery before anything acts on it: it has a delivery id, its
 * signature matches, and its `webhookTimestamp` is within a minute of now.
 */
export function checkDelivery(
  input: { headers: Record<string, string | string[]>; rawBody: string },
  secret: string,
  now: number,
): DeliveryCheck {
  const deliveryId = header(input.headers, "linear-delivery");
  if (!deliveryId) return { ok: false, reason: "missing_delivery_id" };
  if (!signatureMatches(input.rawBody, header(input.headers, "linear-signature"), secret)) {
    return { ok: false, reason: "bad_signature" };
  }
  let timestamp: unknown;
  try {
    timestamp = (JSON.parse(input.rawBody) as { webhookTimestamp?: unknown }).webhookTimestamp;
  } catch {
    return { ok: false, reason: "bad_body" };
  }
  if (typeof timestamp !== "number" || Math.abs(now - timestamp) > MAX_DELIVERY_AGE_MS) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, deliveryId };
}

/** The plugin-state operations delivery dedupe needs. */
export interface DeliveryStore {
  get(key: { scopeKind: "instance"; stateKey: string }): Promise<unknown>;
  set(key: { scopeKind: "instance"; stateKey: string }, value: unknown): Promise<void>;
}

/**
 * Record a delivery id; returns false when it was already recorded, so a
 * retried delivery is handled once. Linear retries the same id after a failure.
 */
export async function firstDelivery(store: DeliveryStore, deliveryId: string, now: number): Promise<boolean> {
  const key = { scopeKind: "instance", stateKey: `linear-delivery:${deliveryId}` } as const;
  if ((await store.get(key)) !== null) return false;
  await store.set(key, now);
  return true;
}
