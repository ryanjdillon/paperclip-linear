# paperclip-linear

A Paperclip plugin that makes Linear the source of truth for work Paperclip's
agents do: intake from Linear agent sessions, status back as agent activity,
and Linear tools for agents. Design stage; no code yet.

## Linear

- Team: `software` (issue prefix `DIL`)
- Project: paperclip-linear
- Repo: https://github.com/ryanjdillon/paperclip-linear (public)

## Tech stack

- TypeScript Paperclip plugin, scaffolded with the Paperclip CLI
  (`plugin init`), built with pnpm; `@paperclipai/plugin-sdk` pinned to an
  exact version
- Linear GraphQL API and webhooks, as an OAuth app installed with `actor=app`

## Common commands

```bash
just check    # docs index and link check
```

## Architecture

See `docs/developer/design.md` and the decision records in
`docs/developer/adr/`.

## Invariants

- Linear owns which work exists and its fields; the plugin never creates a
  Linear issue from Paperclip-only work.
- Every write to Linear has an idempotency key recorded before the call.
- The webhook handler answers within Linear's 5-second limit; slow work goes
  to a job.
- Every agent action on a linked issue traces to the Linear user who
  delegated it.

## Drift discipline

| When you change | Also update |
| --- | --- |
| A design decision | add or supersede an ADR in `docs/developer/adr/`, same commit |
| Routing or what appears in Linear | `docs/user/index.md` |
| Any doc added, moved, or removed | the `index.md` of its directory |

# SYSTEM.md

<!-- Rules for all repos, not only this repo. A periodic process moves them to
     SYSTEM.md in ryanjdillon/agents. Keep this heading. See docs/promotion.md
     in that repo. -->
