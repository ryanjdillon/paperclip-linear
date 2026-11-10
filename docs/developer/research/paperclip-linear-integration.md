# Paperclip with Linear as source of truth: integration survey

**Question:** how can Paperclip run with Linear as the system of record for projects and issues? Linear issues delegated to an agent (or labelled, e.g. `ai:ready`) should become Paperclip tasks. Status, comments, run results and PR links should flow back to Linear, ideally as Agent Session activities. Agents should also be able to create and manage Linear issues.
**Read on:** 2026-11-10. GitHub metadata from `gh api`, npm data from `registry.npmjs.org` and `api.npmjs.org`, both pulled that day.
**Paperclip source:** shallow clone of `paperclipai/paperclip` `master` at `3589774` (2026-11-10). Paths are relative to that repo. Links take the form `https://github.com/paperclipai/paperclip/blob/3589774/<path>`.
**Plugin sources:** shallow clones of each repo below. For `@oldharlem/paperclip-plugin-linear` I also read the npm 0.7.0 tarball, because npm is ahead of GitHub.
**Confidence:** claims with a path or URL were read directly. Claims marked *(unverified)* were not.

---

## 0. Summary

1. **Nothing published fits the goal as-is.** I found eight community Linear plugins (§1). None uses Linear's Agent Session API. Only one is triggered by Linear's `delegate` field, and it is a read-only intake poller. The most complete general sync is `@oldharlem/paperclip-plugin-linear` 0.7.0, but its GitHub repo lags npm and it is a one-day, single-author project.
2. **The built-in Linear connection already lets agents manage Linear issues.** It is a governed proxy to Linear's hosted MCP server (`https://mcp.linear.app/mcp`). Writes are off by default and can be set to "Ask first". The catch is identity: it acts as the human who authorized it, not as an agent identity. It also has no team or project scoping (§2).
3. **The plugin SDK covers what a custom connector needs.** Webhooks, domain events, state, a namespaced DB, outbound HTTP, secrets, issue create/update/comment and wakeups are all there (§3). There are three gaps. Event delivery to plugins is fire-and-forget. The host does not pass Linear's delivery id through, so dedupe is up to the plugin. The SDK has no work-product (PR) read.
4. **Upstream has a spec but no connector.** The roadmap item is still ⚪ planned. A draft "External Task Protocol" spec (merged 2026-07-31) names Linear as the recommended first connector. A related core PR for staged Linear import has been open since 2026-07-31 (§4).
5. **Linear's Agent API supports the target UX.** Delegation creates an `AgentSessionEvent` webhook. Activities, `externalUrls` (for PRs) and plans are available. Linear allows 5 s to answer the webhook and 10 s to post the first activity (§5).
6. **Recommendation: build our own small plugin.** Borrow patterns from Oldharlem 0.7.0 and LaboraiDev, and shape it to the upstream External Task Protocol. Use the built-in Linear MCP connection for agent-initiated Linear work (§6).

---

## 1. Existing Paperclip↔Linear integrations

### 1.1 Inventory

| Project | Stars / forks | Last push | npm (version, downloads last month) | License | SDK pin |
| --- | --- | --- | --- | --- | --- |
| [Oldharlem/paperclip-linear-plugin](https://github.com/Oldharlem/paperclip-linear-plugin) | 5 / 3 | 2026-05-04 | `@oldharlem/paperclip-plugin-linear` 0.7.0, 49 | MIT | `^2026.428.0` |
| [MTAAP/paperclip-plugin-linear-sync](https://github.com/MTAAP/paperclip-plugin-linear-sync) | 3 / 0 | 2026-03-23 | not published (package name is `@paperclipai/plugin-linear-sync`, which is not the official scope's) | MIT | `^2026.318.0` |
| [hrayatnia/paperclip_linear_plugin](https://github.com/hrayatnia/paperclip_linear_plugin) | 1 / 0 | 2026-05-03 | not published | MIT | `^2026.428.0` |
| [LaboraiDev/paperclip-plugin-linear-sync-gate](https://github.com/LaboraiDev/paperclip-plugin-linear-sync-gate) | 0 / 0 | 2026-10-25 | not published | none | `2026.1005.0` |
| [ty000/paperclip-linear-intake](https://github.com/ty000/paperclip-linear-intake) | 0 / 0 | 2026-10-10 | `@ty000/paperclip-linear-intake` 0.6.6, 221 | MIT | `2026.1005.0` |
| [strange-loop-syndicate/paperclip-plugins `linear-intake/`](https://github.com/strange-loop-syndicate/paperclip-plugins/tree/main/linear-intake) | 0 / 0 | 2026-10-27 | not published | none | `2026.1012.0` |
| [llwt/paperclip-plugins `packages/linear`](https://github.com/llwt/paperclip-plugins) | 0 / 0 | 2026-11-01 | `@llwt/paperclip-plugin-linear` 0.2.0, 42 | MIT | n/a |
| [HexSleeves/paperclip-ai-config `packages/linear-plugin`](https://github.com/HexSleeves/paperclip-ai-config) | 0 / 0 | 2026-06-21 | not published | none | vendored copy of Oldharlem |
| `lucitra/paperclip-plugin-linear` | — | — | — | — | Returned by web search ("bidirectional Linear issue sync", ships a forked server `server/src/routes/linear-auth.ts`), but `gh api` returns 404 today. *(unverified, gone or private)* |

How I searched: `gh search repos` with six queries, GitHub code search (`"@paperclipai/plugin-sdk" linear filename:package.json` gave 5 hits; `paperclip "agentActivityCreate"` gave 0), npm search (`paperclip linear`, `paperclip-plugin-linear`, `keywords:paperclip-plugin`, 76 packages), [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip) (994 stars, lists only Oldharlem for Linear), and [docs.paperclip.ing](https://docs.paperclip.ing/) (no plugin directory). I did not search Discord *(not accessible)*. The [businesspress directory](https://paperclip.businesspress.io/) lists Oldharlem, according to web search *(unverified)*.

No Paperclip plugin in any search calls `agentActivityCreate` or handles `AgentSessionEvent`. Hits for `AgentSessionEvent` were all Paperclip's own SDK type (`packages/plugins/sdk/src/types.ts`), which belongs to Paperclip's internal agent chat sessions, not to Linear.

### 1.2 Behaviour

| Project | Linear → Paperclip trigger | Paperclip → Linear | State mapping | Comments | Linear Agent Sessions | Echo / idempotency |
| --- | --- | --- | --- | --- | --- | --- |
| Oldharlem 0.7.0 (npm) | Signed webhook (`Issue`, `Comment`, auto-registered via `webhookCreate`) for issues with label `paperclip` (default), plus cron full and incremental reconcile | Pushes new and updated issues to a mapped team; status by Linear state `type` (`worker.ts` `paperclipStatusToLinearType`) | Paperclip→Linear only. Inbound updates refresh metadata and wake the assignee, but do not change Paperclip status | Both directions; per-comment link records | No | Comment link records plus an in-memory in-flight set; wakeups keyed `linear-comment:<id>`. HMAC checked only if a secret is configured; no `webhookTimestamp` check |
| Oldharlem GitHub (0.4.0) | Same, `Issue` only | Same | Same | Paperclip→Linear only | No | — |
| MTAAP | Poll every 30–60 s, label `Paperclip` | Event subscribers on `issue.updated` and `issue.comment.created` | Configurable name→status table | Both directions | No | Time-window echo guard (5 s grace, `src/sync/echo-guard.ts`) |
| hrayatnia | Cron every 5 min, team plus optional filter, assigned to one fixed agent | `issue.updated` and comment events | Fixed name table (README) | Both directions | No | None found; uses `@linear/sdk` directly instead of `ctx.http`, so the host cannot audit those calls |
| LaboraiDev sync-gate | Signed webhook (HMAC plus 60 s `webhookTimestamp`), Paperclip events debounced 5 s, 5-min sweep. Trigger: `Todo` + label `Ready for AI` → moves the issue to `In Progress` and creates a task | Comments on block/unblock/done; adds and removes a `Blocked` label; relays the agent's reply to a human comment | Only `Todo → In Progress`; never closes the Linear issue | Both directions; human comments attributed to mapped Paperclip users | No, but it uses a Linear **OAuth app actor** with `read write app:mentionable` | Per-action keys, hidden `<!-- linear-sync:… -->` marker, drops its own events, `observe` mode by default |
| ty000 intake | Signed webhook on an authorized move to `Todo`, plus job; imports a parent and its sub-issue family | Optional publisher to a "Council" plugin; disabled by default | n/a | n/a | No | Append-only delivery journal in its own DB namespace. Reads Linear **through Paperclip's tool gateway** (`src/gateway-transport.ts` → `/api/tool-gateway/tools/call`), not directly |
| strange-loop intake | Poll every 2 min: team keys, state type `unstarted`, **`delegate` = agent user** (or assignee) | None by design ("The Project Lead owns all Linear writes") | n/a | No | No | State key plus `[KEY]` title prefix check |
| llwt | Not a sync. Renders live status chips for Linear URLs in Paperclip issues (`objectReferences`), with a manual state-change control | Manual only | Icon by state type | No | No | n/a |

### 1.3 Quality and fit

| Project | Signals | Fit against goal |
| --- | --- | --- |
| Oldharlem | 8 GitHub commits, all on 2026-05-04 by one author. npm 0.5.0 and 0.7.0 were published hours later, with source not pushed (npm `src/worker.ts` is 2,725 lines vs 1,593 on GitHub). One smoke test file. It does request the right host capabilities. | Medium. Closest general sync, but label-triggered and Paperclip-centric (pushes *every* Paperclip issue in mapped projects to Linear). No delegate trigger, no agent sessions, no inbound status. It acts as a personal API key. Its maintenance state is unclear, and the published code is not in the repo. |
| MTAAP | 41 commits, vitest suites, but last activity March 2026 against SDK `2026.318`. Seven months of host churn. | Low to medium. Polling only; the echo guard is time-based. |
| hrayatnia | 12 commits in one day, CI, tests. | Low. Cron only, no echo suppression, bypasses `ctx.http`. |
| LaboraiDev | 8 commits, tests, Spanish docs, hard-wired to one org (a "Programing CEO" agent, `projectllama.cloud`). No license, so it cannot legally be reused as-is. | Concept fit is the best of the group: label-plus-state trigger, Linear stays the interface, app-actor identity, observe mode, markers, sweep backstop. Use it as a design reference only. |
| ty000 | 48 commits, very large test suites, qualification ledgers; coupled to the `paperclip-council` plugin; self-described as not qualified against real Linear. | Low. Too specialised. Its gateway-call pattern is worth knowing (§6). |
| strange-loop | Small and clear README; failure table; no Linear writes. | Low as a whole, but it is the only example of a `delegate`-field trigger. |

---

## 2. Paperclip's built-in Linear support

| Aspect | Finding | Source |
| --- | --- | --- |
| What it is | App definition `linear`, transport `mcp_remote` to `https://mcp.linear.app/mcp`, described as "Create, update, and read Linear issues". Featured. Two methods: `mcp-oauth` (DCR or customer app, scopes `read write`) and `mcp-api-key`. Risk tier S2 ("business data reads and narrow low-risk writes with resource filters"). | `packages/shared/src/app-definitions/linear.json`; `scripts/app-definition-overrides/linear.json` (same content); `doc/connections/FIRST-30-MATRIX.md` l.52, l.84 |
| How agents get it | Through the MCP gateway: Application → Connection → Catalog (each tool classed read/write/destructive) → Profile bound to company/agent/project/routine/issue → Policy (`allow`, `block`, `require_approval`, `rate_limit`, `trust_rule`) → optional human Action Request. Every call is audited. | `doc/MCP-ACCESS-GOVERNANCE.md` §Mental model, l.124 |
| Does it work today? | Qualified 2026-10-08: a live read (list teams) worked; 68 actions discovered; all 30 write actions Off. "Provider writes, refresh-token expiry, and actual agent-adapter execution remain unqualified." | `doc/connections/verified-mcp-qualification-2026-10-08.md` l.16; `doc/connections/tool-method-permission-reviews.json` (linear entry) |
| Write governance | Docs recommend keeping writes on "Ask first". | [docs.paperclip.ing/connectors/linear](https://docs.paperclip.ing/connectors/linear/) |
| Identity | "Issues an agent creates or comments on appear under the authorizing account, not a separate agent identity." The docs advise a dedicated agent account. | same |
| Scope | "No team or project restriction inside Paperclip", one workspace per connection. This conflicts with `requiredResourceFilters: [workspace, team, project]` in the app definition; I treat the docs as current *(unverified which is true)*. | same; `linear.json` |
| OAuth caveat | Open PR [#11078](https://github.com/paperclipai/paperclip/pull/11078) (2026-08-08) says the pinned classic endpoints in `linear.json` block MCP discovery and DCR. The pinned endpoints are still in `linear.json` today, so OAuth DCR setup may fail. The API-key method avoids this *(unverified)*. | PR #11078; `linear.json` |
| Inbound | The connection is outbound tools only. It does not ingest Linear webhooks or create Paperclip tasks. Routine webhook triggers cannot verify `Linear-Signature` (open issue [#16781](https://github.com/paperclipai/paperclip/issues/16781)). | `doc/connections/FIRST-30-MATRIX.md` l.84 ("Issue/comment webhook optional"); #16781 |

**Answer:** yes. A Linear connection gives agents Linear's MCP tools today, governed per tool and per call, so agents can create and update Linear issues. It does not give Linear-side agent identity, team scoping, or inbound sync.

---

## 3. Plugin system maturity

| Question | Finding | Source |
| --- | --- | --- |
| Spec status | "Status: proposed complete spec for the post-V1 plugin system … not part of the V1 implementation contract." Runtime is "early"; fits single-tenant, self-hosted, filesystem-persistent deployments; not cloud-ready for multi-node. | `doc/plugins/PLUGIN_SPEC.md` l.3–31 |
| Authoring guide | Describes "the alpha surface that exists now". Plugin workers and UI are trusted code; UI is not sandboxed. | `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` l.1–27 |
| SDK | `@paperclipai/plugin-sdk`, npm latest `2026.1106.0` (2026-11-06), 2,366 published versions since 2026-03-17 (daily canaries). Scaffold: `paperclipai plugin init` / `@paperclipai/create-paperclip-plugin`. | npm registry; `packages/plugins/sdk/package.json` |
| Inbound webhooks | Yes. Capability `webhooks.receive`, manifest `webhooks[]`, public `POST /api/plugins/:pluginId/webhooks/:endpointKey` with no board auth. The handler gets the raw body (for HMAC) and headers. The host logs each delivery in `plugin_webhook_deliveries`. It calls the worker **synchronously** and returns 200, or 502 on error. **`requestId` is a fresh random UUID**, so dedupe must use Linear's `Linear-Delivery` header. Signature checks are the plugin's job. | `server/src/routes/plugins.ts` l.2750–2900; `packages/plugins/sdk/src/define-plugin.ts` l.155–165, l.330–342 |
| Domain events | `events.subscribe` covers `issue.created/updated/comment.created/checked_out/released/assignment_wakeup_requested`, `issue.document.*`, `issue.relations.updated`, `agent.run.started/finished/failed/cancelled` (payload has `runId, agentId, status, issueId, error`), and `approval.created/decided`. The envelope has `actorType` (`user/agent/system/plugin`) and `actorId`. | `packages/shared/src/constants.ts` `PLUGIN_EVENT_TYPES`; `packages/plugins/sdk/src/types.ts` l.215–234; `server/src/services/heartbeat/run-lifecycle.ts` l.1492–1514 |
| Delivery guarantee | **At most once, in-process.** `publishPluginDomainEvent` does `void bus.emit(...)`; handler errors are only logged. A reconcile job is needed as a backstop (LaboraiDev reached the same conclusion). | `server/src/services/activity-log.ts` l.50–57; `server/src/services/plugin-event-bus.ts` header |
| State / id mapping | `plugin.state.read/write` (scoped KV); `ctx.entities` with `externalId` lookup; namespaced Postgres via `database.namespace.migrate/read/write` (SELECT-only reads, namespace-local writes). Issues carry `originKind: plugin:<key>` and `originId`, and `ctx.issues.list` filters on them. | `PLUGIN_AUTHORING_GUIDE.md` §Plugin database declarations; SDK `types.ts` l.814–870, l.1474–1600 |
| Outbound HTTP / secrets | `http.outbound` (`ctx.http.fetch`, host-audited), `secrets.read-ref`. Known bug: `ctx.http.fetch` throws on 204/205/304 ([#13084](https://github.com/paperclipai/paperclip/issues/13084), open). | constants; #13084 |
| Issue writes | `ctx.issues.create/update/createComment/requestWakeup` (with `idempotencyKey`), `assigneeAgentId`, `blockedByIssueIds`, `labelIds`, `actor` attribution; `getOrchestration` returns runs, approvals and costs. | SDK `types.ts` l.1474–1600, l.1383–1395 |
| Agent tools from plugins | `agent.tools.register` exists, but open issue [#6707](https://github.com/paperclipai/paperclip/issues/6707) reports that plugin tools do not reach `claude_local` / `codex_local` adapters without workarounds. | #6707 |
| PR links | No work-product read in the SDK. The run event payload has no PR URL. Paperclip has a `pull_request` work-product type in core (`packages/shared/src/types/work-product.ts`). A plugin would need the REST API or comment/document parsing *(approach unverified)*. | SDK `types.ts`; shared types |
| Example plugins | In-repo: hello-world, kitchen-sink, file-browser, orchestration-smoke, authoring-smoke (`packages/plugins/examples/`). Tracker sync examples are community only: [mvanhorn/paperclip-plugin-github-issues](https://github.com/mvanhorn/paperclip-plugin-github-issues) (33 stars, last push 2026-03-20, no license) and [Writbase/paperclip-plugin-writbase](https://github.com/Writbase/paperclip-plugin-writbase) (2 stars). | repo tree; `gh api` |

---

## 4. Upstream progress on "Bring-your-own-ticket-system"

| Item | State | Source |
| --- | --- | --- |
| Roadmap entry | ⚪ planned: "Asana, Linear, and Jira can act as familiar on-ramps while Paperclip owns execution, governance, and outcomes." | `ROADMAP.md` l.151–153 |
| External Task Protocol spec | Draft v1, merged in [#10568](https://github.com/paperclipai/paperclip/pull/10568) (2026-07-31). A connector is a plugin. It defines TaskLink, field ownership, a routing pipeline (comment command → custom field → label → state lane → user mapping → default; agents need not be provider users), write toggles (`postProgressComments` on, `mirrorAgentComments` off, `postTranscripts` off), and echo suppression (drop own service-account events plus recent outbound idempotency keys, plus a stable marker). Linear is the "RECOMMENDED first connector". It does **not** mention Linear Agent Sessions or `delegate`. No code references it. | `docs/specs/external-task-protocol.md` §8, §10, App. A.1 |
| Core import PR | [#10572](https://github.com/paperclipai/paperclip/pull/10572) "feat: add staged Linear issue import boundary", open since 2026-07-31, +2342/−3, last update 2026-08-02. Board-only preview/apply/report endpoints; imported issues unassigned; no activation. | PR |
| Origin fields on REST | [#11687](https://github.com/paperclipai/paperclip/pull/11687) persists `originKind/originId` on `POST /issues`; open since 2026-08-19. | PR |
| "Use Linear as the Task Board" | [#3587](https://github.com/paperclipai/paperclip/issues/3587) closed as not planned (2026-08-16). | issue |
| Plugin spec | Uses `@paperclip/plugin-linear` as its running example (team mapping per company, external IDs keyed by issue, a sync-health widget). It is only an example; nothing has shipped. | `doc/plugins/PLUGIN_SPEC.md` l.172, 259, 337, 1372; `doc/plugins/ideas-from-opencode.md` §Linear Issue Tracking |

Upstream intends Paperclip to own execution and Linear to be an on-ramp. That is the reverse of "Linear is the source of truth". Expect any official connector to default to Paperclip-side ownership of status.

---

## 5. Linear side (as of 2026-11-10)

| Topic | Finding | Source |
| --- | --- | --- |
| Install | OAuth with `actor=app` installs the agent as its own workspace actor (admin install; cannot combine with `admin` scope). Scopes `app:assignable` (can be delegated) and `app:mentionable`. | [linear.app/developers/agents](https://linear.app/developers/agents) |
| Delegation | Assigning to an agent sets `delegate`, not `assignee`; the human stays owner. Agents cannot be project members or leads. | same |
| Webhooks | Enable "Agent session events". `AgentSessionEvent` `created` (on delegation or mention; payload has `agentSession`, `promptContext`, `previousComments`, `guidance`) and `prompted` (follow-up in `agentActivity.body`). | [linear.app/developers/agent-interaction](https://linear.app/developers/agent-interaction) |
| Deadlines | Answer the webhook within 5 s. Post an activity or set an external URL within 10 s of `created`, or the session may be marked unresponsive. | same |
| Activities | `agentActivityCreate` with content `thought`, `elicitation`, `action` (`action`, `parameter`, `result`), `response`, `error`. `thought`/`action` may be `ephemeral`. Session states `pending, active, error, awaitingInput, complete, stale` are derived from the last activity. | same |
| PRs and plan | `agentSessionUpdate.externalUrls` (`addedExternalUrls`/`removedExternalUrls`) for PR links. `plan` steps are a "technology preview". | same |
| Proactive sessions | `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`. | same |
| Status | The developer pages carry no preview label except on the Plan API *(GA status not stated explicitly)*. Third-party agents are in production use: GitHub Copilot cloud agent for Linear went GA on 2026-07-23, and a 2026-09-24 changelog routes comment mentions to a third-party agent's latest session. | [GitHub changelog](https://github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available/); [Linear changelog 2026-09-24](https://linear.app/changelog/2026-09-24-new-controls-for-linear-coding-agent) |
| Data webhooks | `Linear-Signature` = hex HMAC-SHA256 of the raw body. Check `webhookTimestamp` within 60 s. `Linear-Delivery` is a UUID per payload. 5 s timeout. Retries at 1 min, 1 h, 6 h, then the webhook may be disabled. Types include Issues, Comments, Issue labels, Projects, and more. | [linear.app/developers/webhooks](https://linear.app/developers/webhooks) |
| Reference code | [linear/weather-bot](https://github.com/linear/weather-bot) (68 stars) sample agent. npm [`@chat-adapter/linear`](https://www.npmjs.com/package/@chat-adapter/linear) 4.44.0 ("@mentions in issue comments and Linear agent sessions"). | GitHub; npm |

---

## 6. Recommendation

**Build our own small plugin.** Do not adopt or fork an existing one.

Reasons:

- None of the plugins implements Linear Agent Sessions or treats Linear as authoritative for status.
- The best general sync (Oldharlem) has its current code only on npm, has one author and one day of history, and is shaped the other way round: it pushes Paperclip issues into Linear.
- The best design (LaboraiDev) has no license and is org-specific.

The SDK has every needed hook. A focused connector is about 1–1.5k lines, judging by the size of the existing plugins. Patterns to borrow: Oldharlem's state-type mapping and comment-link records, LaboraiDev's `observe` mode, markers, app actor and sweep, and strange-loop's `delegate` query. Shape the data model to `docs/specs/external-task-protocol.md` (TaskLink, field ownership, write toggles) so we can swap to an official connector later.

For agent-initiated Linear work (creating and triaging issues), use the **built-in Linear MCP connection** with writes on "Ask first" and a dedicated Linear account. Do not use plugin-registered tools, which have delivery problems (#6707).

### 6.1 Minimal plugin sketch: `linear-bridge`

**Field ownership.** Linear owns title, description, project, priority, labels and workflow state. Paperclip owns execution: checkout, runs, approvals, budget. Paperclip writes back only activities, comments, `externalUrls`, and a small set of mapped state moves (started; in review). Never `completed` unless configured.

**Manifest capabilities.**
- `webhooks.receive` with `webhooks: [{endpointKey: "linear"}]`
- `events.subscribe`, `jobs.schedule` (reconcile every 5 min)
- `http.outbound`, `secrets.read-ref` (OAuth client secret, webhook secret)
- `issues.read`, `issues.create`, `issues.update`, `issues.wakeup`, `issue.comments.read`, `issue.comments.create`, `issues.orchestration.read`
- `database.namespace.migrate`, `database.namespace.read`, `database.namespace.write`
- `activity.log.write`
- Optional: `external.objects.detect` and `external.objects.read` for Linear link chips
- No `agent.tools.register`, no approval or auth capabilities

**Linear identity.** One OAuth app installed with `actor=app` and scopes `read write app:assignable app:mentionable`. Webhook categories: Agent session events, Issues, Comments. Delegation then targets the app, and all write-backs appear as the app, not as a person.

**Tables** (plugin namespace):
- `link(linear_issue_id PK, paperclip_issue_id UNIQUE, agent_session_id, company_id, linear_updated_at, status)`
- `delivery(linear_delivery_id PK, received_at)`
- `outbound(idempotency_key PK, linear_entity_id, created_at)`
- `comment_link(linear_comment_id, paperclip_comment_id)`
- `team_map(linear_team_id, company_id, project_id, default_agent_id, state_map jsonb)`

**Webhook handler** (must return in well under 5 s; the host calls the worker synchronously):
1. Verify `Linear-Signature` over `rawBody`. Reject if `|now − webhookTimestamp| > 60 s`.
2. `INSERT delivery(Linear-Delivery) ON CONFLICT DO NOTHING`. If the row exists, return.
3. Route by event type:
   - `AgentSessionEvent.created`: upsert the link. Create the Paperclip issue (`originKind: plugin:linear-bridge`, `originId: <linearIssueId>`, assignee from `team_map` or the label route). Call `requestWakeup` with key `linear-session:<sessionId>`. Post an ephemeral `thought` ("Queued in Paperclip as X") at once, to meet the 10 s rule.
   - `AgentSessionEvent.prompted`: import the prompt as a Paperclip comment (marked), then wake.
   - `Issue` update with the `ai:ready` label added (no delegate): proactive `agentSessionCreateOnIssue`, then same as `created`.
   - `Issue` update on a linked issue: apply Linear-owned fields to the Paperclip issue. A Linear `canceled` cancels the Paperclip issue.
   - `Comment` on a linked issue from a human: import as a comment and wake. Skip authors equal to the app actor.
   - Anything slow (GraphQL reads of comments or history) is deferred to a job.

**Event handlers** (Paperclip → Linear):

| Paperclip event | Linear write |
| --- | --- |
| `issue.checked_out`, `agent.run.started` | `action` activity ("Working: run R"); move the issue to the team's `started` state if mapped |
| `issue.comment.created` (`actorType` agent) | `response` activity, or `thought` if marked interim |
| `issue.comment.created` (user or plugin, or carrying the marker) | Skip |
| `approval.created` / `issue.interactions` asking a person | `elicitation` |
| `agent.run.failed` | `error` activity with a short reason and the Paperclip link |
| `agent.run.finished` | `getOrchestration`, then a summary `response`; PR URLs found in issue work products or comments go to `addedExternalUrls` |
| `issue.updated` to `in_review` / `done` | Mapped state move per `team_map.state_map`; `done` produces a completion `response` only, unless closure is allowed |

**Idempotency and echo suppression:**
- Every outbound mutation gets a deterministic key (`<paperclipEventOrRunId>:<kind>`), recorded in `outbound` before the call and checked after. Comments carry a hidden `<!-- pc:<key> -->` marker.
- Inbound processing drops events whose actor is the app user, whose body carries a `pc:` marker, or whose entity is in `outbound` from the last N minutes. This is spec §10.4.
- Paperclip-side writes made by the plugin have `actorType: plugin`; the event handlers ignore them.
- Wakeups always pass `idempotencyKey`.

**Reconcile job** (every 5 min, needed because plugin events are at most once):
- For each open link, compare Linear `updatedAt` and session state with Paperclip status and run state.
- Replay missed activities from `getOrchestration`.
- Re-post a `thought` for sessions that would otherwise go `stale` while a run is active.

**Modes:** `observe` (log only) → `act`, per team, as in LaboraiDev.

**How agents also manage Linear tasks:**
- Install the built-in Linear MCP connection with the API-key method, using a key for a dedicated "Paperclip agents" Linear user, or the app token if Paperclip accepts it *(unverified)*.
- Bind a Profile to the agents that need it: reads allowed; `create issue` / `update issue` / `create comment` set to `require_approval` at first, then `allow` per agent once trusted.
- Agents create follow-up issues in Linear, not in Paperclip. The bridge picks them up only if they are delegated or labelled, which keeps Linear the single source of truth.
- Alternative for tighter governance: the plugin can call the same connection through Paperclip's tool gateway (`/api/tool-gateway/tools/call`), as ty000 does. Then even sync writes pass the gateway's policy and audit.

### 6.2 Open risks

- Plugin runtime is alpha and single-node. The SDK ships daily; pin a version (LaboraiDev pins exactly).
- The webhook route is synchronous. A slow worker means Linear timeouts and retries, and Linear may disable the webhook. Keep the handler to verify, insert and enqueue.
- Upstream's direction (Paperclip owns outcomes) may produce an official connector with different field ownership. Mapping to the External Task Protocol limits the cost of switching.
- For oac specifically: agents act through a Linear app actor, so each such write must still trace to an accountable human or circle in oac's model. Recording the delegating human from `AgentSessionEvent` on the link satisfies that.
