# Setup

Connecting one Linear workspace to one Paperclip company.

## Linear

Create an OAuth application (Linear → Settings → API → OAuth applications):

- Scopes: `read`, `write`, `app:assignable`, `app:mentionable`.
- Turn on client credentials, so agents can use an app token (ADR 0007).
- Webhooks: agent session events, issues, and comments, sent to
  `https://<paperclip host>/api/plugins/ryanjdillon.paperclip-linear/webhooks/linear`.
  Paperclip must be reachable from the internet at that address.

Keep the client id, client secret, and webhook signing secret in Paperclip's
secret store.

## Paperclip

Install the plugin, then set its configuration for the company:

| Field | Meaning |
| --- | --- |
| `linearOrganizationId` | The Linear workspace id; deliveries from other workspaces are ignored |
| `webhookSecret` | Secret reference to the webhook signing secret |
| `linearClientId` | The OAuth app's client id |
| `linearClientSecret` | Secret reference to the OAuth app's client secret; the plugin uses it to mint its own app token |
| `mode` | `observe` (log only, the default) or `act` |
| `routing.leads` | Lead agents by name: each a Paperclip project and agent id |
| `routing.projects` | Linear project id to lead name |

Saving the configuration records which company the Linear workspace belongs
to. A delivery whose signature does not match, that is more than a minute
old, or that repeats an earlier delivery id is dropped without retry.
