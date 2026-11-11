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
| An agent starts work | A "working" activity; the issue moves to the started state if mapped |
| An agent comments | A response activity |
| An approval or a question for a person | An elicitation in the agent session |
| A run fails | An error activity with a link to Paperclip |
| A run finishes | A summary response, with pull request links attached |

Linear keeps title, description, project, priority, labels, and workflow
state. Canceling the Linear issue cancels the Paperclip task.
