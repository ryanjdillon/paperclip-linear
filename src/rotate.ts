/**
 * Rotate the Linear app token that agents use through Paperclip's built-in
 * Linear connection (ADR 0007). Run on a schedule, well inside the token's 30
 * days: mint a new client-credentials token and replace the connection's
 * secret through Paperclip's API.
 *
 * Environment:
 *   LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET  the plugin's Linear OAuth app
 *   PAPERCLIP_URL                            Paperclip's base URL (in-cluster is fine)
 *   PAPERCLIP_API_KEY                        a board API key (acts as its user)
 *   PAPERCLIP_SECRET_ID                      the secret behind the Linear connection's key
 *
 * Never prints the token or any secret.
 */
import { pathToFileURL } from "node:url";
import { AppTokenSource, type Fetch } from "./linear/api.js";

export interface RotateEnv {
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  PAPERCLIP_URL?: string;
  PAPERCLIP_API_KEY?: string;
  PAPERCLIP_SECRET_ID?: string;
}

const REQUIRED = ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "PAPERCLIP_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_SECRET_ID"] as const;

export async function rotate(env: RotateEnv, fetch: Fetch): Promise<void> {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing environment: ${missing.join(", ")}`);
  const token = await new AppTokenSource(fetch, env.LINEAR_CLIENT_ID!, env.LINEAR_CLIENT_SECRET!).get();
  const url = `${env.PAPERCLIP_URL!.replace(/\/$/, "")}/api/secrets/${encodeURIComponent(env.PAPERCLIP_SECRET_ID!)}/rotate`;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.PAPERCLIP_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ value: token }),
  });
  if (!response.ok) throw new Error(`Paperclip refused the rotation with ${response.status}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  rotate(process.env as RotateEnv, (url, init) => fetch(url, init))
    .then(() => console.log("Rotated the Linear app token in Paperclip."))
    .catch((error: unknown) => {
      console.error(`Rotation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exit(1);
    });
}
