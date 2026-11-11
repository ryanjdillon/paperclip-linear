import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseConfig, type LinearConfig } from "./config.js";
import { handleAgentSessionEvent, type AgentSessionPayload } from "./intake.js";
import { AppTokenSource, LinearApi, type Fetch } from "./linear/api.js";
import { handleStatusEvent, STATUS_EVENTS } from "./status.js";
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

/** One app token source per company and client id, so tokens survive between deliveries. */
const tokenSources = new Map<string, AppTokenSource>();

async function linearFor(context: PluginContext, companyId: string, config: LinearConfig, fetch: Fetch): Promise<LinearApi> {
  const key = `${companyId}:${config.linearClientId}`;
  let tokens = tokenSources.get(key);
  if (!tokens) {
    const secret = await context.secrets.resolve(config.linearClientSecret);
    tokens = new AppTokenSource(fetch, config.linearClientId, secret);
    tokenSources.set(key, tokens);
  }
  return new LinearApi(fetch, tokens);
}

/** Route outbound calls through the host so they are traced and capability-checked. */
function hostFetch(context: PluginContext): Fetch {
  return (url, init) => context.http.fetch(url, init);
}

/**
 * Handle one Linear delivery. Webhooks carry no Paperclip company, so the
 * Linear workspace id in the payload selects the company. Never throws for a
 * bad delivery: a 502 would make Linear retry something that will never pass.
 */
export async function handleLinearWebhook(
  context: PluginContext,
  input: PluginWebhookInput,
  now = Date.now(),
  fetch: Fetch = hostFetch(context),
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
  const body = input.parsedBody as AgentSessionPayload | undefined;
  if (body?.type === "AgentSessionEvent") {
    try {
      const linear = await linearFor(context, companyId, parsed.config, fetch);
      const outcome = await handleAgentSessionEvent({ ctx: context, linear, companyId, config: parsed.config }, body);
      context.logger.info("Handled a Linear agent session event", { companyId, outcome });
    } catch (error) {
      // The delivery id is already recorded, so a Linear retry would be dropped;
      // the reconcile job (DIL-868) picks up sessions left unhandled.
      context.logger.error("Failed to handle a Linear agent session event", { companyId, error: String(error) });
    }
  }
  return "accepted";
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
    context.data.register("health", async () => ({ status: "ok", checkedAt: new Date().toISOString() }));
    for (const eventType of STATUS_EVENTS) {
      context.events.on(eventType, async (event) => {
        try {
          const parsed = parseConfig(await context.config.get(event.companyId));
          if ("problems" in parsed) return;
          const linear = await linearFor(context, event.companyId, parsed.config, hostFetch(context));
          const outcome = await handleStatusEvent(
            { ctx: context, linear, config: parsed.config, paperclipUrl: parsed.config.paperclipUrl },
            event,
          );
          context.logger.info("Handled a Paperclip event for Linear", { eventType, outcome });
        } catch (error) {
          // Events arrive at most once; the reconcile job (DIL-868) repairs gaps.
          context.logger.error("Failed to report a Paperclip event to Linear", { eventType, error: String(error) });
        }
      });
    }
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
