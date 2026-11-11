# 0007. Agents write to Linear through the built-in connection with an app token

- Status: Accepted
- Date: 2026-11-11
- Supersedes: [0004](0004-agent-tools.md)

## Context

ADR 0004 chose plugin-registered tools, because Paperclip's built-in Linear
connection writes as the person who authorized it and a dedicated Linear user
costs a seat. Reading Paperclip `v2026.1106.0` and Linear's documentation
showed another way:

- The built-in connection's API-key method sends any value as
  `Authorization: Bearer` to `mcp.linear.app`
  (`packages/shared/src/app-definitions/linear.json`).
- Linear's MCP server accepts OAuth tokens and API keys in that header,
  including acting as an app user (linear.app/docs/mcp).
- An OAuth app with client credentials enabled can mint app-actor tokens with
  no user and no seat, valid for 30 days with no refresh token
  (linear.app/developers/oauth-2-0-authentication).

## Decision

Agents use Paperclip's built-in Linear connection, configured with the API-key
method and a client-credentials token of the plugin's Linear app. Their writes
appear as the app. Paperclip's per-tool policies (require approval, then
allow per agent) and audit log govern them. A scheduled job mints a new token
before the old one expires and rotates the connection's secret through
Paperclip's API with a board API key.

## Alternatives considered

- **Plugin-registered tools (ADR 0004).** Can restrict writes to configured
  projects, but needs the undocumented workaround for paperclipai/paperclip#6707
  and more code.
- **Rotating the token by hand every month.** No board key held anywhere, but
  relies on a reminder.

## Consequences

- Writes cannot be limited to particular Linear projects; the connection's
  resource filters are metadata only. Per-tool policies are the control.
- Agents and the plugin's own sync write as the same app, so echo suppression
  must recognize the plugin's own writes by its outbound records and markers,
  never by the app actor.
- The rotation job holds a board API key, which itself expires (30 days by
  default) and needs rotating or a longer lifetime.
- To be confirmed by a live test (DIL-864): that Linear's MCP server accepts a
  client-credentials token, and that the pasted key is stored as a secret that
  can be rotated in place.
