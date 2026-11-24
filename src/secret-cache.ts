/** How long a resolved secret stays in the cache. */
export const SECRET_TTL_MS = 5 * 60_000;

/**
 * The shortest time between two forced refreshes of one key. Each forged
 * delivery forces a refresh, so this keeps forged traffic below the host's
 * limit of 30 secret resolves a minute for each company.
 */
export const MIN_REFRESH_INTERVAL_MS = 10_000;

interface Entry {
  value: Promise<string>;
  resolvedAt: number;
}

/**
 * Keeps resolved secrets for a short time, so that a burst of deliveries
 * does not resolve the same secret again and again. Concurrent misses share
 * one resolve. A failed resolve is not kept, so the next call tries again.
 */
export class SecretCache {
  private readonly entries = new Map<string, Entry>();
  /** When each key was last resolved or refreshed, failed attempts included. */
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = SECRET_TTL_MS,
    private readonly minRefreshMs = MIN_REFRESH_INTERVAL_MS,
  ) {}

  /** The cached value of `key`, or a fresh one from `resolve` after the TTL. */
  get(key: string, resolve: () => Promise<string>): Promise<string> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.resolvedAt < this.ttlMs) return entry.value;
    return this.load(key, resolve);
  }

  /**
   * Resolve `key` again, for example after a signature mismatch from a rotated
   * secret. Returns undefined when the last attempt is too recent; the caller
   * then keeps its result. The old value stays until the new resolve
   * succeeds. A failed attempt also counts, so a host limit does not turn
   * each later delivery into a resolve.
   */
  async refresh(key: string, resolve: () => Promise<string>): Promise<string | undefined> {
    const at = this.now();
    const last = this.attempts.get(key);
    if (last !== undefined && at - last < this.minRefreshMs) return undefined;
    this.attempts.set(key, at);
    const value = await resolve();
    this.entries.set(key, { value: Promise.resolve(value), resolvedAt: at });
    return value;
  }

  /** Forget every key that starts with `prefix`, for example after a config change. */
  clear(prefix = ""): void {
    for (const map of [this.entries, this.attempts]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    }
  }

  private load(key: string, resolve: () => Promise<string>): Promise<string> {
    const entry: Entry = { value: resolve(), resolvedAt: this.now() };
    this.entries.set(key, entry);
    this.attempts.set(key, entry.resolvedAt);
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }
}
