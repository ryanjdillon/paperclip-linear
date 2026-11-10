# 0005. Shape the data model like upstream's External Task Protocol draft

- Status: Accepted
- Date: 2026-11-10

## Context

Paperclip plans its own ticket-system on-ramps and has a draft External Task Protocol (paperclipai/paperclip#10568) that names Linear as the first connector.

## Decision

Links, field ownership, and write toggles follow the draft's concepts where they fit, so the plugin can migrate to, or become, the upstream connector.

## Alternatives considered

- **Ignore the draft.** Rework if upstream ships its own connector.
- **Build inside upstream first.** Slower and depends on maintainers.

## Consequences

Track the draft and adjust when it changes.
