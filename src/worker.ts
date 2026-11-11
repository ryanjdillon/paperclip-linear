import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { checkDelivery, firstDelivery } from "./linear/webhook.js";

/** Instance state key mapping a Linear workspace to the Paperclip company configured for it. */
export function organizationKey(organizationId: string) {
  return { scopeKind: "instance", stateKey: `linear-org:${organizationId}` } as const;
}

/** What happened to one webhook delivery; returned for tests and logged. */
export type WebhookOutcome =
  | "ignored_endpoint"
  | "unknown_organization"
  | "not_configured"
  | "rejected"
  | "duplicate"
  | "accepted";

let ctx: PluginContext | undefined;

/**
 * Handle one Linear delivery. Webhooks carry no Paperclip company, so the
 * Linear workspace id in the payload selects the company. Never throws for a
 * bad delivery: a 502 would make Linear retry something that will never pass.
 */
export async function handleLinearWebhook(
  context: PluginContext,
  input: PluginWebhookInput,
  now = Date.now(),
): Promise<WebhookOutcome> {
  if (input.endpointKey !== "linear") return "ignored_endpoint";
  const organizationId = (input.parsedBody as { organizationId?: unknown } | undefined)?.organizationId;
  const companyId =
    typeof organizationId === "string" ? await context.state.get(organizationKey(organizationId)) : null;
  if (typeof companyId !== "string") {
    context.logger.warn("Linear delivery for an unconfigured workspace", { organizationId });
    return "unknown_organization";
  }
  const parsed = parseConfig(await context.config.get(companyId));
  if ("problems" in parsed) {
    context.logger.warn("Linear plugin is not configured for this company", { companyId, problems: parsed.problems });
    return "not_configured";
  }
  const secret = await context.secrets.resolve(parsed.config.webhookSecret);
  const check = checkDelivery(input, secret, now);
  if (!check.ok) {
    context.logger.warn("Rejected a Linear delivery", { companyId, reason: check.reason });
    return "rejected";
  }
  if (!(await firstDelivery(context.state, check.deliveryId, now))) return "duplicate";
  context.logger.info("Accepted a Linear delivery", { companyId, deliveryId: check.deliveryId, mode: parsed.config.mode });
  return "accepted";
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
    context.data.register("health", async () => ({ status: "ok", checkedAt: new Date().toISOString() }));
  },

  async onConfigChanged(newConfig, change) {
    if (!ctx || !change?.companyId) return;
    const parsed = parseConfig(newConfig);
    if ("config" in parsed) {
      await ctx.state.set(organizationKey(parsed.config.linearOrganizationId), change.companyId);
    }
  },

  async onValidateConfig(config) {
    const parsed = parseConfig(config);
    return "problems" in parsed ? { ok: false, errors: parsed.problems } : { ok: true };
  },

  async onWebhook(input) {
    if (ctx) await handleLinearWebhook(ctx, input);
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
