import { describe, expect, it } from "vitest";
import { LINEAR_TOKEN_URL, type Fetch } from "../src/linear/api.js";
import { rotate, type RotateEnv } from "../src/rotate.js";

const env: RotateEnv = {
  LINEAR_CLIENT_ID: "client",
  LINEAR_CLIENT_SECRET: "secret",
  PAPERCLIP_URL: "http://paperclip:3100/",
  PAPERCLIP_API_KEY: "pcp_board_x",
  PAPERCLIP_SECRET_ID: "sec-1",
};

function fakes(rotateStatus = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url === LINEAR_TOKEN_URL) return { status: 200, ok: true, json: async () => ({ access_token: "lin_new", expires_in: 2592000 }) };
    return { status: rotateStatus, ok: rotateStatus < 300, json: async () => ({}) };
  };
  return { fetch, calls };
}

describe("token rotation", () => {
  it("mints an app token and rotates the connection's secret with it", async () => {
    const { fetch, calls } = fakes();
    await rotate(env, fetch);
    expect(calls[0].url).toBe(LINEAR_TOKEN_URL);
    expect(calls[1].url).toBe("http://paperclip:3100/api/secrets/sec-1/rotate");
    expect(calls[1].headers.authorization).toBe("Bearer pcp_board_x");
    expect(JSON.parse(calls[1].body)).toEqual({ value: "lin_new" });
  });

  it("names every missing variable and calls nothing", async () => {
    const { fetch, calls } = fakes();
    await expect(rotate({ PAPERCLIP_URL: "x" }, fetch)).rejects.toThrow(
      "Missing environment: LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, PAPERCLIP_API_KEY, PAPERCLIP_SECRET_ID",
    );
    expect(calls).toEqual([]);
  });

  it("fails without echoing the token when Paperclip refuses", async () => {
    const { fetch } = fakes(403);
    const error = await rotate(env, fetch).catch((e: Error) => e);
    expect(String(error)).toContain("403");
    expect(String(error)).not.toContain("lin_new");
  });
});
