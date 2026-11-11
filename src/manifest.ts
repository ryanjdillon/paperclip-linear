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
    "http.outbound",
    "issues.create",
    "issues.wakeup",
    "issue.comments.create",
    "issue.comments.read",
    "issues.read",
    "issues.update",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "ui.dashboardWidget.register",
  ],
  instanceConfigSchema: configSchema as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "Reconcile with Linear",
      description: "Replays missed reports, cancels tasks whose Linear issue was canceled, keeps sessions alive",
      schedule: "*/5 * * * *",
    },
  ],
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
