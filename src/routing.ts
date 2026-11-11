/** Where a lead agent's work goes in Paperclip. */
export interface Lead {
  paperclipProjectId: string;
  agentId: string;
}

/** Routing configuration (ADR 0003). */
export interface RoutingConfig {
  /** Lead agents by name, as used in `lead:<name>` labels. */
  leads: Record<string, Lead>;
  /** Linear project id to lead name. */
  projects: Record<string, string>;
}

export type Route =
  | { kind: "lead"; name: string; lead: Lead; by: "label" | "project" }
  | { kind: "ask"; reason: "no_match" | "several_lead_labels" | "unknown_lead" };

const LEAD_LABEL = /^lead:(.+)$/i;

/**
 * Pick the lead for a Linear issue: a single `lead:<name>` label wins, then
 * the issue's Linear project; otherwise a person is asked in the agent session.
 */
export function route(issue: { labels: string[]; projectId?: string | null }, config: RoutingConfig): Route {
  const named = issue.labels.map((label) => LEAD_LABEL.exec(label.trim())?.[1]?.trim().toLowerCase()).filter(
    (name): name is string => Boolean(name),
  );
  const distinct = [...new Set(named)];
  if (distinct.length > 1) return { kind: "ask", reason: "several_lead_labels" };
  if (distinct.length === 1) {
    const name = distinct[0];
    const lead = config.leads[name];
    return lead ? { kind: "lead", name, lead, by: "label" } : { kind: "ask", reason: "unknown_lead" };
  }
  const name = issue.projectId ? config.projects[issue.projectId] : undefined;
  if (!name) return { kind: "ask", reason: "no_match" };
  const lead = config.leads[name];
  return lead ? { kind: "lead", name, lead, by: "project" } : { kind: "ask", reason: "unknown_lead" };
}
