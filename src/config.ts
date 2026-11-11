import type { RoutingConfig } from "./routing.js";

/** A shared Paperclip secret reference, as stored in plugin config. */
export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: number;
}

/** One company's plugin configuration. */
export interface LinearConfig {
  /** The Linear workspace (organization) id this company is connected to. */
  linearOrganizationId: string;
  /** The Linear app's webhook signing secret. */
  webhookSecret: SecretRef;
  /** `observe` logs what the plugin would do; `act` does it (ADR 0006). */
  mode: "observe" | "act";
  routing: RoutingConfig;
}

/** JSON Schema shown to the operator in Paperclip's plugin settings. */
export const configSchema = {
  type: "object",
  required: ["linearOrganizationId", "webhookSecret"],
  properties: {
    linearOrganizationId: { type: "string", title: "Linear workspace id" },
    webhookSecret: { type: "object", title: "Linear webhook signing secret", format: "secret-ref" },
    mode: { type: "string", enum: ["observe", "act"], default: "observe", title: "Mode" },
    routing: {
      type: "object",
      title: "Routing",
      properties: {
        leads: {
          type: "object",
          description: "Lead agents by name, used by `lead:<name>` labels",
          additionalProperties: {
            type: "object",
            required: ["paperclipProjectId", "agentId"],
            properties: { paperclipProjectId: { type: "string" }, agentId: { type: "string" } },
          },
        },
        projects: {
          type: "object",
          description: "Linear project id to lead name",
          additionalProperties: { type: "string" },
        },
      },
    },
  },
} as const;

/** Parse stored config; returns the problems instead of throwing. */
export function parseConfig(raw: Record<string, unknown>): { config: LinearConfig } | { problems: string[] } {
  const problems: string[] = [];
  const org = raw.linearOrganizationId;
  if (typeof org !== "string" || org.trim() === "") problems.push("linearOrganizationId is required");
  const secret = raw.webhookSecret as Partial<SecretRef> | undefined;
  if (!secret || secret.type !== "secret_ref" || typeof secret.secretId !== "string") {
    problems.push("webhookSecret must be a secret reference");
  }
  const mode = raw.mode ?? "observe";
  if (mode !== "observe" && mode !== "act") problems.push("mode must be observe or act");
  const routing = (raw.routing ?? {}) as Partial<RoutingConfig>;
  const leads = routing.leads ?? {};
  const projects = routing.projects ?? {};
  for (const [name, lead] of Object.entries(leads)) {
    if (name !== name.toLowerCase()) problems.push(`lead name ${name} must be lowercase`);
    if (typeof lead?.paperclipProjectId !== "string" || typeof lead?.agentId !== "string") {
      problems.push(`lead ${name} needs paperclipProjectId and agentId`);
    }
  }
  for (const [project, name] of Object.entries(projects)) {
    if (!(name in leads)) problems.push(`project ${project} routes to unknown lead ${name}`);
  }
  if (problems.length > 0) return { problems };
  return {
    config: {
      linearOrganizationId: (org as string).trim(),
      webhookSecret: secret as SecretRef,
      mode: mode as LinearConfig["mode"],
      routing: { leads, projects },
    },
  };
}
