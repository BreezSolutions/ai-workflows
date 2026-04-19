import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { Server as SocketIO } from "socket.io";
import { createApp } from "./api/app.js";
import { startSlackBot } from "./bot/slack.js";
import { startScheduler } from "./core/scheduler.js";
import { startGmailPoller } from "./core/gmail-poller.js";
import { connectDB, cleanupStaleRuns } from "./core/db.js";
import { bus } from "./core/events.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function cleanupOldSessions(): Promise<void> {
  const baseDir = path.join(process.env.HOME ?? "/root", ".claude", "projects", "-app");
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    let deleted = 0;
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          if (entry.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
          else fs.unlinkSync(fullPath);
          deleted++;
        }
      } catch {}
    }
    if (deleted > 0) console.log(`[CLEANUP] Deleted ${deleted} old session file(s) from ${baseDir}`);
  } catch {}
}

async function main(): Promise<void> {
  console.log("Starting ai-workflows...");

  await connectDB();
  await cleanupStaleRuns();
  await cleanupOldSessions();

  const app = createApp();
  const server = http.createServer(app);
  const io = new SocketIO(server, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
  });

  bus.on("workflow_event", (event) => {
    io.emit("workflow_event", event);
  });

  server.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
  });

  if (process.env.NODE_ENV === "production" || process.env.ENABLE_SLACK_BOT === "true") {
    await startSlackBot();
  } else {
    console.log("Slack bot disabled (set NODE_ENV=production or ENABLE_SLACK_BOT=true to enable)");
  }

  if (process.env.NODE_ENV === "production" || process.env.ENABLE_SCHEDULER === "true") {
    await startScheduler();
  } else {
    console.log("Scheduler disabled (set NODE_ENV=production or ENABLE_SCHEDULER=true to enable)");
  }

  if (process.env.NODE_ENV === "production" || process.env.ENABLE_GMAIL_POLLER === "true") {
    await startGmailPoller();
  } else {
    console.log("Gmail poller disabled (set NODE_ENV=production or ENABLE_GMAIL_POLLER=true to enable)");
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[PROCESS] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[PROCESS] Uncaught exception:", err);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
