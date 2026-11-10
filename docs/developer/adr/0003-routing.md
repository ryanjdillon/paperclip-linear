# 0003. One Linear app, routed by label then project

- Status: Accepted
- Date: 2026-11-10

## Context

The workspace has one Linear team for now, so routing by team is not possible. A separate Linear app per lead agent means an OAuth app, secrets, and a webhook each. An LLM orchestrator would add a relaying middle layer and cost on every issue.

## Decision

One Linear app. The plugin routes an issue by a `lead:<name>` label if present, otherwise by its Linear project, to a Paperclip project and lead agent from configuration. With no match it asks in the agent session. More Linear teams later become one more routing key.

## Alternatives considered

- **One Linear app per lead agent.** Several apps to register and maintain; can be added later.
- **An orchestrator agent.** A middle layer doing what a lookup does.

## Consequences

Routing rules live in plugin configuration and are visible to whoever administers it.
