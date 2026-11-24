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
  `agentSessions(first: 50, orderBy: createdAt)` and `viewer { id }`. These
  facts come from Linear's
  [GraphQL schema](https://github.com/linear/linear/blob/2ca00918e3ae699a0aa1a6b07330b433397cd201/packages/sdk/src/schema.graphql) at
  that commit:
  - `agentSessions` has no filter argument, so the plugin keeps only
    sessions whose `appUser` is the viewer.
  - `viewer` is "the account making this request. For OAuth applications
    using actor=app, this is the application account." The plugin's token
    is a client-credentials token with the app actor (ADR 0007).
  - With `first`, "results are newest first". The plugin also sorts the
    sessions newest first and checks the age of each session, so it does not
    depend on that order.

  The job runs the `created` intake for each session that has no session
  link, at most 10 for each company in one run. It skips these sessions:
  - younger than 2 minutes, because the delivery can still arrive;
  - older than 24 hours, dismissed, or with no issue;
  - with the status `complete` or `stopping`;
  - on an issue that is completed or canceled, or that is no longer
    delegated to the app;
  - on an issue that already has an open Paperclip task, because a later
    delegation of that issue was routed (logged at debug level).

  The job keeps sessions with the status `pending`, `error`, or `stale`.
  Linear marks a session unresponsive when it gets no activity within 10
  seconds of `created`, and a lost delivery always causes that. The
  [developer docs](https://linear.app/developers/agent-interaction) do not
  say which status that is.

  Only the company that the webhook maps the Linear workspace to
  (`linear-org:<id>`, set from the config) recovers sessions, so two
  companies on one workspace do not both start work.

  Intake records the session link, so a late delivery for a recovered session
  is a duplicate. Paperclip runs each plugin in one worker process that talks
  JSON-RPC to the host (SDK `protocol.d.ts`, "Process Model"), and the webhook
  and the job both run in it. Intake marks the session in memory before its
  first await and reads the link again after the mark, so two calls at the
  same time create one task. The mark does not cover two worker processes at
  the same time, for example if a restart overlaps the old and the new
  worker. Then a second task is possible only if a delivery and a recovery
  start inside the same few seconds, after the 2-minute grace period.

  The mark is released when intake ends. Intake cannot pass an
  `AbortSignal` to Linear: `ctx.http.fetch` sends only the method, headers,
  and body to the host. Every call from the worker to the host, `http.fetch`
  and the issue and state calls included, fails after 30 seconds
  (`DEFAULT_RPC_TIMEOUT_MS` in the SDK's `worker-rpc-host.js`). So a hung
  call holds the mark for at most 30 seconds.

  Each recovered session gets one log line with `outcome: "recovered"` and
  its age; a failure logs the age too. In observe mode intake writes no link.
  The job counts such sessions as `observed`, not against the limit of 10,
  and reports them again in each run for 24 hours.
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
