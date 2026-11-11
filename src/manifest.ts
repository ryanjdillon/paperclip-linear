import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { configSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "ryanjdillon.paperclip-linear",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear",
  description: "Makes Linear the source of truth for work Paperclip agents do",
  author: "ryanjdillon",
  categories: ["connector"],
  capabilities: [
    "webhooks.receive",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "ui.dashboardWidget.register",
  ],
  instanceConfigSchema: configSchema as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  webhooks: [
    {
      endpointKey: "linear",
      displayName: "Linear",
      description: "Agent session, issue, and comment events from the Linear app",
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Linear Health",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
