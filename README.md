# paperclip-linear

A [Paperclip](https://paperclip.ing) plugin that makes [Linear](https://linear.app)
the source of truth for work that Paperclip's agents do.

- **Intake.** Delegate a Linear issue to the plugin's Linear agent. The plugin
  creates the linked Paperclip task, routes it to the right agent, and wakes it.
- **Status back.** Paperclip progress, questions, failures, results, and pull
  request links appear on the Linear issue as agent activity.
- **Agents in Linear.** Agents can create and update Linear issues as the
  plugin's Linear app, within the projects you allow.

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

To try it, run Paperclip from a source checkout and install this folder from
its absolute path: `pnpm paperclipai plugin install /path/to/paperclip-linear`
in the Paperclip checkout. Local installs run trusted code from this folder.

`@paperclipai/plugin-sdk` and `@paperclipai/shared` are pinned to the exact
Paperclip release the plugin is tested against; upgrade them together with the
Paperclip instance.

## License

MIT
