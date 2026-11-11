# paperclip-linear

A [Paperclip](https://paperclip.ing) plugin that makes [Linear](https://linear.app)
the source of truth for work that Paperclip's agents do.

- **Intake.** Delegate a Linear issue to the plugin's Linear agent. The plugin
  creates the linked Paperclip task, routes it to the right agent, and wakes it.
- **Status back.** Paperclip progress, questions, failures, results, and pull
  request links appear on the Linear issue as agent activity.
- **Agents in Linear.** Agents can create and update Linear issues as the
  plugin's Linear app, through Paperclip's built-in Linear connection.

Linear owns what work exists and its priority; Paperclip owns how it gets
done. Nothing created only in Paperclip is pushed into Linear.

## Status

Scaffold. The design is in [docs/index.md](docs/index.md).

## Development

Requires Node 24.11+ and pnpm (`nix develop` provides both, plus `just`).

```bash
pnpm install --frozen-lockfile
just check      # docs, typecheck, tests, dependency audit (CI runs this)
pnpm dev        # rebuild dist/ on change
```

Tagged releases (`v*`) publish `ghcr.io/ryanjdillon/paperclip-linear`: the
official Paperclip image with the plugin baked in (see
[setup](docs/user/setup.md)). Pull requests that touch the image only build it.

To try it locally, run the published Paperclip release the SDK is pinned to
(`npx paperclipai@2026.1106.0 run`) and install this folder from its absolute
path: `npx paperclipai@2026.1106.0 plugin install /path/to/paperclip-linear`.
Local installs run trusted code from this folder. A Paperclip source checkout
installed with a newer pnpm skips the release's dependency patches, so do not
run the server from one.

`@paperclipai/plugin-sdk` and `@paperclipai/shared` are pinned to the exact
Paperclip release the plugin is tested against; upgrade them together with the
Paperclip instance.

## License

MIT
