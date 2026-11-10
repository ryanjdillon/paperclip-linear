# 0001. Linear is the source of truth; Paperclip executes

- Status: Accepted
- Date: 2026-11-10

## Context

Work is planned in Linear. Paperclip runs agents, budgets, and approvals. Two systems that both own tasks drift apart.

## Decision

Linear owns which work exists and its fields. Paperclip owns execution. The plugin brings delegated Linear issues into Paperclip and reports progress back. Nothing created only in Paperclip goes to Linear.

## Alternatives considered

- **Full two-way sync.** Blurs ownership and needs conflict handling.
- **Intake only.** Leaves results visible only in Paperclip.

## Consequences

Agents that create follow-up work do it in Linear (ADR 0004).
