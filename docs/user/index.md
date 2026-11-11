# User docs

How the plugin behaves for someone working in Linear and Paperclip.

- [Setup](setup.md): connecting a Linear workspace to a Paperclip company.

## Getting work to an agent

Delegate a Linear issue to the plugin's Linear agent. The plugin replies in
the issue's agent session within seconds, creates the linked Paperclip task,
and wakes the agent the task is routed to.

## Routing

The plugin picks the Paperclip project and lead agent for an issue in this
order:

1. **Label.** A `lead:<name>` label routes to the lead agent named in the
   plugin's configuration.
2. **Linear project.** The configuration maps each Linear project to a
   Paperclip project and its lead agent.
3. **Nobody.** If neither matches, the plugin asks in the agent session which
   lead should take it, and waits.

The lead agent may delegate further inside Paperclip.

## What shows up in Linear

| In Paperclip | In Linear |
| --- | --- |
| An agent starts work | A "working" activity; the issue moves to the started state if configured |
| An agent comments | A response activity; people's and the plugin's own comments are not sent |
| An approval or a question for a person | An elicitation in the agent session |
| A run fails | An error activity with a link to Paperclip |
| An agent links a pull request in a comment | The link is attached to the agent session |
| The task moves to review | The issue moves to the review state if configured |
| The task is done | A "finished" response; the issue moves to done only if `closeOnDone` is on |

Linear keeps title, description, project, priority, and labels. The plugin
changes an issue's workflow state only to the states you configure.
Every 5 minutes a reconcile job cancels Paperclip tasks whose Linear issue
was canceled, sends agent comments and completions whose events were missed,
and keeps sessions with work in progress from going stale in Linear.
