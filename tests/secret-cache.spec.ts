import { describe, expect, it } from "vitest";
import { MIN_REFRESH_INTERVAL_MS, SECRET_TTL_MS, SecretCache } from "../src/secret-cache.js";

function counter(values: string[]) {
  let calls = 0;
  return {
    resolve: async () => values[Math.min(calls++, values.length - 1)]!,
    calls: () => calls,
  };
}

describe("SecretCache", () => {
  it("resolves once within the TTL and again after it", async () => {
    let t = 0;
    const cache = new SecretCache(() => t);
    const source = counter(["a", "b"]);
    expect(await cache.get("k", source.resolve)).toBe("a");
    t = SECRET_TTL_MS - 1;
    expect(await cache.get("k", source.resolve)).toBe("a");
    expect(source.calls()).toBe(1);
    t = SECRET_TTL_MS;
    expect(await cache.get("k", source.resolve)).toBe("b");
    expect(source.calls()).toBe(2);
  });

  it("shares one resolve between concurrent misses", async () => {
    const cache = new SecretCache();
    const source = counter(["a"]);
    const values = await Promise.all(Array.from({ length: 40 }, () => cache.get("k", source.resolve)));
    expect(new Set(values)).toEqual(new Set(["a"]));
    expect(source.calls()).toBe(1);
  });

  it("does not keep a failed resolve", async () => {
    const cache = new SecretCache();
    let fail = true;
    const resolve = async () => {
      if (fail) throw new Error("Rate limit exceeded for secret resolution");
      return "a";
    };
    await expect(cache.get("k", resolve)).rejects.toThrow("Rate limit");
    fail = false;
    expect(await cache.get("k", resolve)).toBe("a");
  });

  it("refreshes at most once per interval", async () => {
    let t = 0;
    const cache = new SecretCache(() => t);
    const source = counter(["old", "new", "newer"]);
    await cache.get("k", source.resolve);
    expect(await cache.refresh("k", source.resolve)).toBeUndefined();
    t = MIN_REFRESH_INTERVAL_MS;
    expect(await cache.refresh("k", source.resolve)).toBe("new");
    expect(await cache.get("k", source.resolve)).toBe("new");
    expect(await cache.refresh("k", source.resolve)).toBeUndefined();
    expect(source.calls()).toBe(2);
  });

  it("forgets the keys of one company", async () => {
    const cache = new SecretCache();
    const source = counter(["a", "b", "c"]);
    await cache.get("c1:s", source.resolve);
    await cache.get("c2:s", source.resolve);
    cache.clear("c1:");
    expect(await cache.get("c1:s", source.resolve)).toBe("c");
    expect(await cache.get("c2:s", source.resolve)).toBe("b");
  });
});
