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

Run the image `ghcr.io/ryanjdillon/paperclip-linear`, pinned by digest. It is
the official Paperclip image with the plugin at
`/opt/paperclip-plugins/paperclip-linear`. Paperclip's automatic install
covers only its own bundled plugins, so register this one once from that
path; the registration persists, and later images replace the code at the
same path, loaded on restart:

```bash
paperclipai plugin install /opt/paperclip-plugins/paperclip-linear
```

(Unverified: whether the CLI must run inside the container or can point at
the server from outside; the path must be readable by the server.)

Then set its configuration for the company:

| Field | Meaning |
| --- | --- |
| `linearOrganizationId` | The Linear workspace id; deliveries from other workspaces are ignored |
| `webhookSecret` | Secret reference to the webhook signing secret |
| `linearClientId` | The OAuth app's client id |
| `linearClientSecret` | Secret reference to the OAuth app's client secret; the plugin uses it to mint its own app token |
| `mode` | `observe` (log only, the default) or `act` |
| `routing.leads` | Lead agents by name: each a Paperclip project and agent id |
| `routing.projects` | Linear project id to lead name |
| `states` | Optional Linear workflow state ids: `started`, `inReview`, `done`; linked issues move only to states listed here |
| `closeOnDone` | Whether a finished Paperclip task moves the Linear issue to `states.done` (default false) |
| `paperclipUrl` | Optional base URL of the Paperclip UI, used in links from Linear (the private tailnet address is fine) |

Saving the configuration records which company the Linear workspace belongs
to. A delivery whose signature does not match, that is more than a minute
old, or that repeats an earlier delivery id is dropped without retry.
