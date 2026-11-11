import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "ryanjdillon.paperclip-linear",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear",
  description: "Makes Linear the source of truth for work Paperclip agents do",
  author: "ryanjdillon",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Linear Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
