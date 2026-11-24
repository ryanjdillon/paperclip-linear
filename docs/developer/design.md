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
an issue to done only if the configuration allows it. A workflow state
belongs to one team. Before each move, the plugin reads the team of the issue
and the team of the state. If they are not the same, it skips the move and
logs it. Thus a routed issue from another team keeps its state.

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
- **Webhook handler.** First reads the delivery's type and action. It
  answers every delivery that is not an agent session `created` or
  `prompted` event at once, and does nothing else for it. Paperclip allows
  30 secret resolves a minute for each company and plugin, and bursts of
  issue and comment events used up that limit (DIL-865). For an agent
  session event, the handler finds the company from the payload's Linear
  workspace id, verifies the signature and timestamp, records the
  `Linear-Delivery` id to drop duplicates, then handles the event inline: an
  acknowledgement first, then one issue read, routing, the Paperclip task, and
  a wakeup. The signing secret stays in the worker for 5 minutes. A
  signature mismatch resolves it again, at most once in 10 seconds, so a
  rotated secret still works. A mismatch inside those 10 seconds, or after a
  failed resolve, gets a 502 with no resolve, so Linear sends the delivery
  again later. The task is created as `todo`: Paperclip
  defaults to `backlog`, and it refuses to wake an agent on a backlog issue.
  Linear expects an answer within 5 seconds and a first activity within 10.
  The SDK awaits the handler before the host answers, so the handler cannot
  answer first; a test keeps a routed intake under half that limit. If that
  proves too slow, the read and task creation move to a job.
- **Event handlers.** Turn Paperclip events into Linear activities and state
  moves (table in [user docs](../user/index.md#what-shows-up-in-linear)).
- **Reconcile job.** Plugin events arrive at most once, so every 5 minutes the
  job walks each configured company's linked tasks (found by origin, since
  jobs carry no company and plugin state cannot be listed). It cancels tasks
  whose Linear issue was canceled, and retries the wake of a routed task in
  `backlog` or `todo` that has no queued wake on record. Each retry uses a new
  idempotency key, because the server may keep the key of a refused wake. It
  replays agent comments and completions with no outbound record. It posts a
  status thought for any open task quiet for 20 minutes, except after a
  question to the owner. Linear keeps a session that asked a question in
  "Needs input" with no help (probed 2026-11-20, DIL-940). A thought may
  replace that state (not probed). Each post is recorded with its type as soon
  as it is made, because a later step of the same event can fail and the
  event is not retried.
- **Session recovery.** A `created` delivery can be lost before it reaches
  the plugin, and Linear does not always send it again (DIL-992: the client
  closed the connection after 31 ms, and no retry came). The reconcile job
  therefore also reads the app's 50 newest agent sessions with
  `agentSessions(first: 50, orderBy: createdAt)` and `viewer { id }`.
  `agentSessions` has no filter argument (Linear's
  [GraphQL schema](https://github.com/linear/linear/blob/2ca00918e3ae699a0aa1a6b07330b433397cd201/packages/sdk/src/schema.graphql)),
  so the plugin keeps only sessions whose `appUser` is the viewer. It runs the
  `created` intake for each session that has no session link, at most 10 for
  each company in one run. It skips a session that is younger than 2 minutes,
  because its delivery can still arrive. It skips a session that is older
  than 24 hours, a dismissed session, and a session with no issue. It also
  skips a session whose Linear issue already has an open Paperclip task,
  because a later delegation of that issue was routed. Intake records the
  session link, so a late delivery for a recovered session is a duplicate.
  The webhook and the job run in one worker. Intake claims the session in
  memory before its first await and reads the link again inside the claim,
  so two calls at the same time create one task. Each recovered session gets
  one log line with `outcome: "recovered"`. In observe mode intake writes no
  link, so the job reports the same session again in each run for 24 hours.
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

Per company configuration, `observe` (log what it would do, write nothing to
either side) then `act`. Per-project modes are a possible later refinement.

## Accountability

The `link` row records the Linear user who delegated the issue, so every agent
action on it traces to a person.
