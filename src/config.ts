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
  /** The Linear OAuth app's client id; with the secret it mints app tokens. */
  linearClientId: string;
  /** The Linear OAuth app's client secret. */
  linearClientSecret: SecretRef;
  /** `observe` logs what the plugin would do; `act` does it (ADR 0006). */
  mode: "observe" | "act";
  routing: RoutingConfig;
  /** Linear workflow state ids to move linked issues to; each is optional. */
  states: { started?: string; inReview?: string; done?: string };
  /** Whether a finished Paperclip task may move the Linear issue to `done`. */
  closeOnDone: boolean;
  /** Base URL of the Paperclip UI, for links back from Linear; optional. */
  paperclipUrl?: string;
}

/** JSON Schema shown to the operator in Paperclip's plugin settings. */
export const configSchema = {
  type: "object",
  required: ["linearOrganizationId", "webhookSecret", "linearClientId", "linearClientSecret"],
  properties: {
    linearOrganizationId: { type: "string", title: "Linear workspace id" },
    webhookSecret: { type: "object", title: "Linear webhook signing secret", format: "secret-ref" },
    linearClientId: { type: "string", title: "Linear OAuth app client id" },
    linearClientSecret: { type: "object", title: "Linear OAuth app client secret", format: "secret-ref" },
    mode: { type: "string", enum: ["observe", "act"], default: "observe", title: "Mode" },
    states: {
      type: "object",
      title: "Linear workflow states",
      description: "State ids linked issues move to; leave empty to never move them",
      properties: { started: { type: "string" }, inReview: { type: "string" }, done: { type: "string" } },
    },
    closeOnDone: { type: "boolean", default: false, title: "Move to done when the Paperclip task is done" },
    paperclipUrl: { type: "string", title: "Paperclip URL for links from Linear", format: "uri" },
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
  const clientId = raw.linearClientId;
  if (typeof clientId !== "string" || clientId.trim() === "") problems.push("linearClientId is required");
  const clientSecret = raw.linearClientSecret as Partial<SecretRef> | undefined;
  if (!clientSecret || clientSecret.type !== "secret_ref" || typeof clientSecret.secretId !== "string") {
    problems.push("linearClientSecret must be a secret reference");
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
  const states = (raw.states ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(states)) {
    if (!["started", "inReview", "done"].includes(key)) problems.push(`states.${key} is not a known state`);
    else if (typeof value !== "string") problems.push(`states.${key} must be a state id`);
  }
  const closeOnDone = raw.closeOnDone ?? false;
  if (typeof closeOnDone !== "boolean") problems.push("closeOnDone must be true or false");
  if (closeOnDone === true && typeof states.done !== "string") problems.push("closeOnDone needs states.done");
  const paperclipUrl = raw.paperclipUrl;
  if (paperclipUrl !== undefined && (typeof paperclipUrl !== "string" || !/^https?:\/\//.test(paperclipUrl))) {
    problems.push("paperclipUrl must be an http(s) URL");
  }
  if (problems.length > 0) return { problems };
  return {
    config: {
      linearOrganizationId: (org as string).trim(),
      webhookSecret: secret as SecretRef,
      linearClientId: (clientId as string).trim(),
      linearClientSecret: clientSecret as SecretRef,
      mode: mode as LinearConfig["mode"],
      routing: { leads, projects },
      states: states as LinearConfig["states"],
      closeOnDone: closeOnDone as boolean,
      ...(typeof paperclipUrl === "string" ? { paperclipUrl } : {}),
    },
  };
}
