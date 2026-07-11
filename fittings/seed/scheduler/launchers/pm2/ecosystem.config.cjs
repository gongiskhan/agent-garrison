// PM2 launcher for the Garrison scheduler daemon (any OS PM2 runs on).
//   pm2 start pm2/ecosystem.config.cjs
// Set SCHEDULER to the absolute path of scheduler.mjs (or edit `script` below).
module.exports = {
  apps: [
    {
      name: "garrison-scheduler",
      script: process.env.SCHEDULER || require("path").resolve(__dirname, "..", "..", "scripts", "scheduler.mjs"),
      args: ["daemon", "--health-port", process.env.GARRISON_SCHEDULER_HEALTH_PORT || "7099"],
      interpreter: "node",
      autorestart: true,
      kill_timeout: 10000,
      env: {
        GARRISON_SCHEDULER_HEALTH_PORT: process.env.GARRISON_SCHEDULER_HEALTH_PORT || "7099"
      }
    }
  ]
};
