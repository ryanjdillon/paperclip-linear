# 0004. Agents write to Linear through plugin tools as the app

- Status: Accepted
- Date: 2026-11-10

## Context

Agents should create and manage Linear issues. Paperclip's built-in Linear connection writes as the human who authorized it, and a dedicated Linear user costs a seat. Plugin-registered tools are not delivered to agent runs automatically (paperclipai/paperclip#6707); a documented workaround makes them available through a tool gateway connection installed per agent.

## Decision

The plugin registers Linear tools (create, update, comment) that write as the Linear app, limited to configured projects and attributed to the acting agent in Paperclip. The plugin sets up the #6707 workaround for each agent that is granted the tools. Before building them, check whether the built-in Linear connection accepts the app's token, which would give app attribution without the workaround.

## Alternatives considered

- **The built-in connection with a dedicated Linear user.** Costs a seat.
- **The built-in connection as the owner.** Agent writes would appear as a person.

## Consequences

Depends on an undocumented workaround until #6707 is fixed.
