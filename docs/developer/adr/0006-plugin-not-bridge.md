# 0006. A Paperclip plugin, with a reconcile job

- Status: Accepted
- Date: 2026-11-10

## Context

Paperclip has no outbound webhooks, so only a plugin receives its events without polling. Plugin events are delivered at most once, and the plugin SDK is alpha.

## Decision

Build a Paperclip plugin. Pin the SDK version. Add a reconcile job every 5 minutes, and an observe mode before act.

## Alternatives considered

- **A separate bridge service.** Would have to poll Paperclip's activity log or hold a WebSocket.

## Consequences

Upgrades of Paperclip need a test run against a pinned version.
