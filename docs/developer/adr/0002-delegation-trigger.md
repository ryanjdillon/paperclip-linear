# 0002. Delegating to the plugin's Linear agent starts the work

- Status: Accepted
- Date: 2026-11-10

## Context

Linear's agent API opens an agent session when an issue is delegated to an app, and shows its activity on the issue.

## Decision

Delegating an issue to the plugin's Linear app is the trigger. Humans keep the assignee field. Progress is reported as agent activities in that session.

## Alternatives considered

- **A label or a workflow state.** No agent session view in Linear; easier to trigger by accident.

## Consequences

Linear's 5-second webhook and 10-second first-activity limits shape the handler (design doc).
