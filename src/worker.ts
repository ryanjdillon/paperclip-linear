import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseConfig, type LinearConfig } from "./config.js";
import { HANDLED_SESSION_ACTIONS, handleAgentSessionEvent, type AgentSessionPayload } from "./intake.js";
import { AppTokenSource, LinearApi, type Fetch } from "./linear/api.js";
import { COMPANIES_KEY, RECONCILE_JOB, reconcileCompany } from "./reconcile.js";
import { handleStatusEvent, STATUS_EVENTS } from "./status.js";
import { checkDelivery, firstDelivery } from "./linear/webhook.js";
import { SecretCache } from "./secret-cache.js";

/** Instance state key mapping a Linear workspace to the Paperclip company configured for it. */
export function organizationKey(organizationId: string) {
  return { scopeKind: "instance", stateKey: `linear-org:${organizationId}` } as const;
}

/** What happened to one webhook delivery; returned for tests and logged. */
export type WebhookOutcome =
  | "ignored_endpoint"
  | "ignored_type"
  | "unknown_organization"
  | "not_configured"
  | "rejected"
  | "duplicate"
  | "accepted";

let ctx: PluginContext | undefined;

/** One app token source per company and client id, so tokens survive between deliveries. */
export const tokenSources = new Map<string, AppTokenSource>();

async function linearFor(context: PluginContext, companyId: string, config: LinearConfig, fetch: Fetch): Promise<LinearApi> {
  const key = `${companyId}:${config.linearClientId}`;
  let tokens = tokenSources.get(key);
  if (!tokens) {
    // Webhooks and jobs run outside a company invocation, so every secret
    // lookup names its company; the host refuses it otherwise.
    const secret = () => context.secrets.resolve(config.linearClientSecret, { companyId, configPath: "linearClientSecret" });
    tokens = new AppTokenSource(fetch, config.linearClientId, secret);
    tokenSources.set(key, tokens);
  }
  return new LinearApi(fetch, tokens);
}

/**
 * Webhook signing secrets for each company. Without the cache, every agent
 * session delivery resolves the secret, and a burst goes past the host's
 * limit of 30 resolves a minute.
 */
export const webhookSecrets = new SecretCache();

/** Route outbound calls through the host so they are traced and capability-checked. */
function hostFetch(context: PluginContext): Fetch {
  return (url, init) => context.http.fetch(url, init);
}

/**
 * True for the deliveries the plugin acts on. The type and action are read
 * before the signature check. A forged value can only make the plugin skip a
 * delivery, and a skipped delivery has no effect.
 */
export function isHandledDelivery(body: unknown): boolean {
  const { type, action } = (body ?? {}) as { type?: unknown; action?: unknown };
  return type === "AgentSessionEvent" && typeof action === "string" && HANDLED_SESSION_ACTIONS.includes(action);
}

/**
 * Handle one Linear delivery. Deliveries the plugin does not act on get an
 * answer at once. The host limits secret resolves to 30 a minute for each
 * company, and a burst of issue or comment events used up that limit.
 * Webhooks carry no Paperclip company, so the Linear workspace id in the
 * payload selects the company. Never throws for a delivery that is surely
 * bad: a 502 would make Linear retry something that will never pass. It
 * throws, so Linear retries, for a host failure before the delivery id is
 * recorded (for example the host's secret-resolve limit). It also throws for
 * a signature mismatch that it cannot check against a fresh secret yet.
 */
export async function handleLinearWebhook(
  context: PluginContext,
  input: PluginWebhookInput,
  now = Date.now(),
  fetch: Fetch = hostFetch(context),
): Promise<WebhookOutcome> {
  if (input.endpointKey !== "linear") return "ignored_endpoint";
  if (!isHandledDelivery(input.parsedBody)) return "ignored_type";
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
  const ref = parsed.config.webhookSecret;
  const secretKey = `${companyId}:${ref.secretId}:${ref.version ?? "latest"}`;
  const resolve = () => context.secrets.resolve(ref, { companyId, configPath: "webhookSecret" });
  let check = checkDelivery(input, await webhookSecrets.get(secretKey, resolve), now);
  if (!check.ok && check.reason === "bad_signature") {
    // The secret may have been rotated in place behind the same ref.
    let fresh: string | undefined;
    try {
      fresh = await webhookSecrets.refresh(secretKey, resolve);
    } catch (error) {
      context.logger.warn("Could not resolve the webhook secret again", { companyId, error: String(error) });
    }
    if (fresh === undefined) {
      // The cached secret can be old, so the delivery can be real. A 502 makes
      // Linear send it again later; a 200 would lose a new session. This path
      // resolves nothing, so forged deliveries cannot use up the host limit.
      throw new Error("Linear signature mismatch; the webhook secret cannot be checked again yet");
    }
    check = checkDelivery(input, fresh, now);
  }
  if (!check.ok) {
    context.logger.warn("Rejected a Linear delivery", { companyId, reason: check.reason });
    return "rejected";
  }
  if (!(await firstDelivery(context.state, check.deliveryId, now))) return "duplicate";
  context.logger.info("Accepted a Linear delivery", { companyId, deliveryId: check.deliveryId, mode: parsed.config.mode });
  try {
    const linear = await linearFor(context, companyId, parsed.config, fetch);
    const body = input.parsedBody as AgentSessionPayload;
    const outcome = await handleAgentSessionEvent({ ctx: context, linear, companyId, config: parsed.config }, body);
    context.logger.info("Handled a Linear agent session event", { companyId, outcome });
  } catch (error) {
    // The delivery id is already recorded, so a Linear retry would be dropped;
    // the reconcile job (DIL-868) picks up sessions left unhandled.
    context.logger.error("Failed to handle a Linear agent session event", { companyId, error: String(error) });
  }
  return "accepted";
}

/** Reconcile every configured company; one company's failure does not stop the others. */
export async function runReconcile(context: PluginContext, now: number, fetch: Fetch): Promise<void> {
  const companies = ((await context.state.get(COMPANIES_KEY)) as string[] | null) ?? [];
  for (const companyId of companies) {
    try {
      const parsed = parseConfig(await context.config.get(companyId));
      if ("problems" in parsed) continue;
      const linear = await linearFor(context, companyId, parsed.config, fetch);
      const report = await reconcileCompany(context, linear, companyId, parsed.config, now);
      context.logger.info("Reconciled with Linear", { companyId, mode: parsed.config.mode, ...report });
    } catch (error) {
      context.logger.error("Reconcile failed for a company", { companyId, error: String(error) });
    }
  }
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
    context.data.register("health", async () => ({ status: "ok", checkedAt: new Date().toISOString() }));
    context.jobs.register(RECONCILE_JOB, async () => {
      await runReconcile(context, Date.now(), hostFetch(context));
    });
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
    // A changed config may point a secret at another ref; drop cached token
    // sources so the next mint resolves the new one.
    for (const key of [...tokenSources.keys()]) if (key.startsWith(`${change.companyId}:`)) tokenSources.delete(key);
    webhookSecrets.clear(`${change.companyId}:`);
    const parsed = parseConfig(newConfig);
    if ("config" in parsed) {
      await ctx.state.set(organizationKey(parsed.config.linearOrganizationId), change.companyId);
      const companies = ((await ctx.state.get(COMPANIES_KEY)) as string[] | null) ?? [];
      if (!companies.includes(change.companyId)) await ctx.state.set(COMPANIES_KEY, [...companies, change.companyId]);
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
