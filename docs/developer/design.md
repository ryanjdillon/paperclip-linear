# Design

The plugin connects one Linear workspace to one Paperclip company. The
[research note](research/paperclip-linear-integration.md) has the evidence;
the [decision records](adr/index.md) have the choices.

## Field ownership

| Owned by Linear | Owned by Paperclip |
| --- | --- |
| Title, description, project, priority, labels, workflow state | Checkout, runs, approvals, budget, agent assignment |

Paperclip writes back only agent activities, comments, external URLs (pull
requests), and a configured set of state moves (started, in review). It moves
an issue to done only if the configuration allows it.

## Components

```
Linear ──webhook──► plugin worker ──► Paperclip issues, wakeups
  ▲                    │   ▲
  └── GraphQL as app ──┘   └── Paperclip domain events (runs, comments, approvals)
                       │
                       └── reconcile job (every 5 min)
```

- **Linear identity.** One OAuth app installed with `actor=app`, scopes
  `read write app:assignable app:mentionable`, webhook categories agent
  session events, issues, and comments. Every write appears as the app. The
  plugin mints its own client-credentials token from the app's client id and
  secret, keeps it until a day before it expires, and replaces it after a
  401.
- **Webhook handler.** Finds the company from the payload's Linear workspace
  id, verifies the signature and timestamp, records the `Linear-Delivery` id
  to drop duplicates, then handles agent session events inline: an
  acknowledgement first, then one issue read, routing, the Paperclip task, and
  a wakeup. Linear expects an answer within 5 seconds and a first activity
  within 10; if that proves too slow, the read and task creation move to a
  job.
- **Event handlers.** Turn Paperclip events into Linear activities and state
  moves (table in [user docs](../user/index.md#what-shows-up-in-linear)).
- **Reconcile job.** Plugin events arrive at most once, so every 5 minutes the
  job compares open links with both sides and replays what was missed.
- **Agents in Linear.** Agents use Paperclip's built-in Linear connection,
  authenticated with a client-credentials token of the same Linear app, so
  their writes also appear as the app (ADR 0007). A scheduled job rotates the
  token before its 30 days run out.

## Data (plugin database namespace)

| Table | Holds |
| --- | --- |
| `link` | Linear issue, Paperclip issue, agent session, delegating Linear user, last seen `updatedAt` |
| `delivery` | Linear delivery ids already handled |
| `outbound` | Idempotency keys of writes to Linear, recorded before the call |
| `comment_link` | Linear comment to Paperclip comment |
| `route` | Label and Linear project to Paperclip project and lead agent; state map |

## Echo suppression and idempotency

- Every write to Linear has a key `<paperclip event or run id>:<kind>`, stored
  in `outbound` before the call; comments carry a hidden `<!-- pc:<key> -->`
  marker.
- Inbound events are dropped when their body carries a `pc:` marker or their
  entity and change match a row in `outbound`. Never by actor: agents write as
  the same Linear app, and their work must come through.
- Paperclip writes made by the plugin have `actorType: plugin`, and the event
  handlers ignore them.
- Every wakeup passes an idempotency key.

## Modes

Per Linear project, `observe` (log what it would do) then `act`.

## Accountability

The `link` row records the Linear user who delegated the issue, so every agent
action on it traces to a person.
