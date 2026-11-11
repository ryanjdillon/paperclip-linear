import { describe, expect, it } from "vitest";
import { route, type RoutingConfig } from "../src/routing.js";

const config: RoutingConfig = {
  leads: {
    delivery: { paperclipProjectId: "pc-delivery", agentId: "agent-delivery" },
    sales: { paperclipProjectId: "pc-sales", agentId: "agent-sales" },
  },
  projects: { "lin-website": "delivery", "lin-orphan": "nobody" },
};

describe("route", () => {
  it("prefers a lead label over the project", () => {
    expect(route({ labels: ["bug", "lead:Sales"], projectId: "lin-website" }, config)).toMatchObject({
      kind: "lead",
      name: "sales",
      by: "label",
    });
  });

  it("falls back to the Linear project", () => {
    expect(route({ labels: ["bug"], projectId: "lin-website" }, config)).toMatchObject({
      kind: "lead",
      name: "delivery",
      by: "project",
    });
  });

  it("asks a person when nothing matches", () => {
    expect(route({ labels: [], projectId: null }, config)).toEqual({ kind: "ask", reason: "no_match" });
    expect(route({ labels: [], projectId: "lin-unmapped" }, config)).toEqual({ kind: "ask", reason: "no_match" });
  });

  it("asks a person when lead labels disagree", () => {
    expect(route({ labels: ["lead:sales", "lead:delivery"] }, config)).toEqual({ kind: "ask", reason: "several_lead_labels" });
  });

  it("asks a person when the named lead is not configured", () => {
    expect(route({ labels: ["lead:finance"] }, config)).toEqual({ kind: "ask", reason: "unknown_lead" });
    expect(route({ labels: [], projectId: "lin-orphan" }, config)).toEqual({ kind: "ask", reason: "unknown_lead" });
  });

  it("treats the same lead label twice as one", () => {
    expect(route({ labels: ["lead:sales", "Lead:Sales "] }, config)).toMatchObject({ kind: "lead", name: "sales" });
  });
});
