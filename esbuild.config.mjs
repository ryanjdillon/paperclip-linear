import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// The token rotation script runs on its own (a scheduled job), not in the plugin worker.
const rotate = {
  entryPoints: ["src/rotate.ts"],
  outfile: "dist/rotate.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
};

const contexts = await Promise.all([
  esbuild.context(presets.esbuild.worker),
  esbuild.context(presets.esbuild.manifest),
  esbuild.context(presets.esbuild.ui),
  esbuild.context(rotate),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("esbuild watch mode enabled for worker, manifest, ui, and rotate");
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
