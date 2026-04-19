import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import path from "path";
import { fileURLToPath } from "url";
import workflowRoutes from "./routes/workflows.js";
import executionRoutes from "./routes/executions.js";
import approvalRoutes from "./routes/approvals.js";
import triggerRoutes from "./routes/triggers.js";
import connectionRoutes from "./routes/connections.js";
import actionStagingRoutes from "./routes/action-staging.js";
import authRoutes from "./routes/auth.js";
import { slackThrottle } from "../core/throttle.js";
import * as db from "../core/db.js";
import { get as getEmoji } from "node-emoji";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache Slack user ID → display name to avoid repeated API calls
const slackUserNameCache = new Map<string, string>();

async function resolveSlackMentions(text: string): Promise<string> {
  const mentionRegex = /<@(U[A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  if (matches.length === 0) return text;
  let result = text;
  for (const m of matches) {
    const name = await resolveSlackUserName(m[1]);
    result = result.replace(m[0], `@${name}`);
  }
  return result;
}

// Custom emoji cache: name → image URL (loaded once from workspace)
let customEmojiCache: Map<string, string> | null = null;

async function loadCustomEmojis(): Promise<Map<string, string>> {
  if (customEmojiCache) return customEmojiCache;
  try {
    const conn = await db.getConnection("slack");
    const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
    if (!token) return (customEmojiCache = new Map());
    await slackThrottle();
    const res = await fetch("https://slack.com/api/emoji.list", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as any;
    const map = new Map<string, string>();
    if (data.ok && data.emoji) {
      for (const [name, url] of Object.entries(data.emoji)) {
        map.set(name, url as string);
      }
      console.log(`[SLACK] Loaded ${map.size} custom emojis`);
    } else {
      console.error("[SLACK] emoji.list failed:", data.error ?? "unknown");
    }
    customEmojiCache = map;
    return map;
  } catch (err) {
    console.error("[SLACK] emoji.list error:", err);
    return (customEmojiCache = new Map());
  }
}

async function resolveSlackEmojis(text: string): Promise<string> {
  const customEmojis = await loadCustomEmojis();
  return text.replace(/:([a-z0-9_+\-]+):/g, (match, name) => {
    // Standard emoji first
    const emoji = getEmoji(name);
    if (emoji) return emoji;
    // Custom workspace emoji — return as an img tag that the frontend can render
    const customUrl = customEmojis.get(name);
    if (customUrl) {
      // Handle aliases (alias:other_name)
      if (customUrl.startsWith("alias:")) {
        const aliasName = customUrl.slice(6);
        const aliasEmoji = getEmoji(aliasName);
        if (aliasEmoji) return aliasEmoji;
        const aliasUrl = customEmojis.get(aliasName);
        if (aliasUrl && !aliasUrl.startsWith("alias:")) {
          return `<img class="slack-emoji" src="${aliasUrl}" alt=":${name}:" title=":${name}:" />`;
        }
      } else {
        return `<img class="slack-emoji" src="${customUrl}" alt=":${name}:" title=":${name}:" />`;
      }
    }
    return match;
  });
}

function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export async function resolveSlackUserName(userId: string): Promise<string> {
  const cached = slackUserNameCache.get(userId);
  if (cached) return cached;
  try {
    // Try user token first (works across workspaces), fall back to bot token
    const conn = await db.getConnection("slack");
    const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
    if (!token) return userId;
    await slackThrottle();
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as any;
    const name = data.user?.real_name || data.user?.profile?.display_name || data.user?.name || userId;
    slackUserNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

export function createApp(): express.Application {
  const app = express();

  // Trust proxy (needed for secure cookies behind Fly.dev / nginx / etc.)
  app.set("trust proxy", 1);

  // Session middleware
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGO_DB || process.env.MONGODB_DB_NAME || "workflow_platform";
  app.use(session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: mongoUri, dbName, collectionName: "sessions" }),
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  }));

  app.use(express.json());

  // Auth routes (no auth required)
  app.use("/api/auth", authRoutes);

  // Auth middleware — require login for all /api/* routes except auth and OAuth callbacks
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth")) return next();
    if (req.path === "/connections/gmail/callback") return next();
    if (req.path === "/connections/slack/callback") return next();

    // Allow internal server-side calls (workflows/agent runs)
    const internalUserId = req.headers["x-internal-user-id"] as string;
    if (internalUserId && (req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1")) {
      (req as any).userId = internalUserId;
      return next();
    }

    const userId = (req.session as any)?.userId;
    if (!userId) return res.status(401).json({ error: "Not logged in" });
    (req as any).userId = userId;
    next();
  });

  // API routes
  app.use("/api/workflows", workflowRoutes);
  app.use("/api/executions", executionRoutes);
  app.use("/api/approvals", approvalRoutes);
  app.use("/api/workflows", triggerRoutes);
  app.use("/api/connections", connectionRoutes);
  app.use("/api/executions", actionStagingRoutes);

  // Slack Events API — receives user-scoped events (message.channels, message.groups, etc.)
  // Dedup: Slack retries deliveries and may send the same event_id multiple times
  const seenEventIds = new Set<string>();
  app.post("/slack/events", (req, res) => {
    const body = req.body;

    // URL verification challenge (Slack sends this when you set the Request URL)
    if (body.type === "url_verification") {
      res.json({ challenge: body.challenge });
      return;
    }

    // Acknowledge immediately (Slack expects 200 within 3 seconds)
    res.status(200).send();

    // Dedup by event_id
    const eventId = body.event_id;
    if (eventId) {
      if (seenEventIds.has(eventId)) return;
      seenEventIds.add(eventId);
      // Evict old entries to prevent unbounded growth
      if (seenEventIds.size > 10_000) {
        const first = seenEventIds.values().next().value!;
        seenEventIds.delete(first);
      }
    }

    // Slack events here are purely for URL verification + the Slack bolt bot,
    // which handles its own event subscriptions. Nothing else to do at this
    // level — the core app is what tracks conversation activity.
  });

  // Slack channels list
  app.get("/api/slack/channels", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.json([]);
      const channels: { id: string; name: string }[] = [];
      let cursor: string | undefined;
      do {
        const url = new URL("https://slack.com/api/conversations.list");
        url.searchParams.set("types", "public_channel");
        url.searchParams.set("exclude_archived", "true");
        url.searchParams.set("limit", "1000");
        if (cursor) url.searchParams.set("cursor", cursor);
        await slackThrottle();
        const result = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await result.json() as any;
        if (!data.ok) {
          console.error("Slack conversations.list error:", data.error);
          return res.json([]);
        }
        for (const c of data.channels ?? []) {
          channels.push({ id: c.id, name: c.name });
        }
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);
      channels.sort((a, b) => a.name.localeCompare(b.name));
      res.json(channels);
    } catch {
      res.json([]);
    }
  });

  // Slack users search
  app.get("/api/slack/users", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.json([]);
      const members: { id: string; name: string; real_name: string }[] = [];
      let cursor: string | undefined;
      do {
        const url = new URL("https://slack.com/api/users.list");
        url.searchParams.set("limit", "500");
        if (cursor) url.searchParams.set("cursor", cursor);
        await slackThrottle();
        const result = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await result.json() as any;
        if (!data.ok) {
          console.error("Slack users.list error:", data.error);
          return res.json([]);
        }
        for (const m of data.members ?? []) {
          if (m.deleted || m.is_bot) continue;
          members.push({ id: m.id, name: m.name, real_name: m.real_name || m.name });
        }
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);
      const q = (req.query.q as string || "").toLowerCase();
      const filtered = q ? members.filter(m => m.real_name.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : members;
      filtered.sort((a, b) => a.real_name.localeCompare(b.real_name));
      res.json(filtered);
    } catch {
      res.json([]);
    }
  });

  // Slack channel info (works for private/connect channels too)
  app.get("/api/slack/channels/:channelId/info", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.json({ id: req.params.channelId, name: req.params.channelId });
      await slackThrottle();
      const result = await fetch(`https://slack.com/api/conversations.info?channel=${req.params.channelId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await result.json() as any;
      if (data.ok && data.channel) {
        res.json({ id: data.channel.id, name: data.channel.name });
      } else {
        res.json({ id: req.params.channelId, name: req.params.channelId });
      }
    } catch {
      res.json({ id: req.params.channelId, name: req.params.channelId });
    }
  });

  // Slack channel messages (for test picker)
  app.get("/api/slack/channels/:channelId/messages", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.json([]);
      await slackThrottle();
      const result = await fetch("https://slack.com/api/conversations.history", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: req.params.channelId, limit: 50 }),
      });
      const data = await result.json() as any;
      if (!data.ok) {
        console.error("Slack conversations.history error:", data.error);
        return res.json([]);
      }
      // Return messages with resolved user names, oldest first
      const raw = (data.messages ?? []).reverse();
      const messages = [];
      for (const m of raw) {
        const userName = m.user ? await resolveSlackUserName(m.user) : "";
        const resolvedText = decodeSlackEntities(await resolveSlackEmojis(await resolveSlackMentions(m.text ?? "")));
        messages.push({
          ts: m.ts,
          text: resolvedText,
          user: userName,
          thread_ts: m.thread_ts,
          reply_count: m.reply_count ?? 0,
          blocks: m.blocks,
          files: m.files?.map((f: any) => ({ name: f.name, title: f.title, mimetype: f.mimetype })),
        });
      }
      res.json(messages);
    } catch {
      res.json([]);
    }
  });

  // Slack thread replies
  app.get("/api/slack/channels/:channelId/threads/:threadTs", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.json([]);
      const params = new URLSearchParams({ channel: req.params.channelId, ts: req.params.threadTs, limit: "100" });
      await slackThrottle();
      const result = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await result.json() as any;
      if (!data.ok) {
        console.error("Slack conversations.replies error:", data.error);
        return res.json([]);
      }
      const messages = [];
      for (const m of (data.messages ?? [])) {
        const userName = m.user ? await resolveSlackUserName(m.user) : "";
        const resolvedText = decodeSlackEntities(await resolveSlackEmojis(await resolveSlackMentions(m.text ?? "")));
        messages.push({
          ts: m.ts,
          text: resolvedText,
          user: userName,
          thread_ts: m.thread_ts,
          blocks: m.blocks,
        });
      }
      res.json(messages);
    } catch {
      res.json([]);
    }
  });

  // Slack channel files
  app.get("/api/slack/channels/:channelId/files", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.json([]);
      const params = new URLSearchParams({ channel: req.params.channelId, count: "100" });
      await slackThrottle();
      const result = await fetch(`https://slack.com/api/files.list?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await result.json() as any;
      if (!data.ok) {
        console.error("Slack files.list error:", data.error);
        return res.json([]);
      }
      const files = (data.files ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        url_private: f.url_private,
        user: f.user,
        timestamp: f.timestamp,
      }));
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  // Download a Slack file by ID (proxies through the bot token)
  // GET /api/slack/files/:fileId/download -> streams file content
  app.get("/api/slack/files/:fileId/download", async (req, res) => {
    try {
      const conn = await db.getConnection("slack", (req as any).userId);
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) return res.status(500).json({ error: "No Slack token" });

      // Get file info
      await slackThrottle();
      const infoRes = await fetch(`https://slack.com/api/files.info?file=${req.params.fileId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const infoData = await infoRes.json() as any;
      if (!infoData.ok) return res.status(404).json({ error: infoData.error });

      const file = infoData.file;
      // Download the file content
      const dlRes = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!dlRes.ok) return res.status(502).json({ error: "Failed to download from Slack" });

      res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Upload a file to a Slack channel/thread
  // POST { file_path: "/tmp/foo.pdf", channel: "C123", thread_ts: "123.456", filename?: "foo.pdf", comment?: "Here's the file" }
  // OR { file_url: "https://...", channel, thread_ts, filename?, comment? }
  app.post("/api/slack/upload", async (req, res) => {
    try {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return res.status(500).json({ error: "SLACK_BOT_TOKEN not set" });

      const { file_path, file_url, channel, thread_ts, filename, comment } = req.body;
      if (!channel) return res.status(400).json({ error: "channel is required" });

      let fileBuffer: Buffer;
      let finalFilename: string;

      if (file_path) {
        const fs = await import("fs");
        const path = await import("path");
        if (!fs.existsSync(file_path)) return res.status(400).json({ error: `File not found: ${file_path}` });
        fileBuffer = fs.readFileSync(file_path);
        finalFilename = filename || path.basename(file_path);
      } else if (file_url) {
        // Download from URL (supports Slack file URLs with auth)
        const headers: Record<string, string> = {};
        if (file_url.includes("slack.com") || file_url.includes("files.slack.com")) {
          const conn = await db.getConnection("slack", (req as any).userId);
          const slackToken = conn?.credentials?.user_token || token;
          headers["Authorization"] = `Bearer ${slackToken}`;
        }
        const resp = await fetch(file_url, { headers });
        if (!resp.ok) return res.status(400).json({ error: `Failed to download: ${resp.status}` });
        const arrayBuf = await resp.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
        finalFilename = filename || file_url.split("/").pop()?.split("?")[0] || "file";
      } else {
        return res.status(400).json({ error: "file_path or file_url is required" });
      }

      // Upload to Slack using the SDK (files.uploadV2 requires the SDK, not raw fetch)
      const { WebClient } = await import("@slack/web-api");
      const slack = new WebClient(token);
      const uploadResult = await slack.filesUploadV2({
        file: fileBuffer,
        filename: finalFilename,
        channel_id: channel,
        thread_ts: thread_ts || undefined,
        initial_comment: comment || undefined,
      });
      console.log(`[SLACK UPLOAD] Uploaded ${finalFilename} to ${channel}${thread_ts ? ` (thread ${thread_ts})` : ""}`);
      res.json({ ok: true, file: (uploadResult as any).file });
    } catch (err) {
      console.error("Slack upload error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Gmail thread messages (full bodies, for approval detail view)
  app.get("/api/gmail/threads/:threadId/messages", async (req, res) => {
    try {
      const { fetchGmailThread } = await import("../core/list-fetchers.js");
      const limit = parseInt(req.query.limit as string) || 10;
      const slim = req.query.slim !== "0"; // default to slim
      const messages = await fetchGmailThread(req.params.threadId, slim);
      res.json(messages.slice(-limit));
    } catch (err) {
      console.error("Gmail thread messages error:", err);
      res.status(500).json({ error: "Failed to fetch thread messages" });
    }
  });

  // Single Gmail message body (loaded on demand when user expands)
  app.get("/api/gmail/messages/:messageId/body", async (req, res) => {
    try {
      const { fetchGmailMessage } = await import("../core/list-fetchers.js");
      const msg = await fetchGmailMessage(req.params.messageId);
      res.json(msg);
    } catch (err) {
      console.error("Gmail message body error:", err);
      res.status(500).json({ error: "Failed to fetch message body" });
    }
  });

  // Batch Gmail thread/message headers (for previewing actions)
  // POST { threads: ["id1", ...], messages: ["id1", ...] }
  app.post("/api/gmail/headers", async (req, res) => {
    try {
      const conn = await db.getConnection("gmail", (req as any).userId);
      if (!conn) return res.json({ threads: {}, messages: {} });

      const { google } = await import("googleapis");
      const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      auth.setCredentials(conn.credentials);
      const gmail = google.gmail({ version: "v1", auth });

      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = (profile.data.emailAddress ?? "").toLowerCase();
      const [localPart, domain] = myEmail.split("@");

      const threadIds: string[] = [...new Set(req.body.threads ?? [])] as string[];
      const messageIds: string[] = [...new Set(req.body.messages ?? [])] as string[];

      const threadResults: Record<string, any> = {};
      const messageResults: Record<string, any> = {};

      // Fetch threads (concurrently, max 10 at a time)
      const threadBatches = [];
      for (let i = 0; i < threadIds.length; i += 10) {
        threadBatches.push(threadIds.slice(i, i + 10));
      }
      for (const batch of threadBatches) {
        await Promise.all(batch.map(async (tid) => {
          try {
            const thread = await gmail.users.threads.get({
              userId: "me", id: tid, format: "metadata",
              metadataHeaders: ["Subject", "From", "To"],
            });
            const msgs = thread.data.messages ?? [];
            const first = msgs[0];
            const last = msgs[msgs.length - 1];
            const getH = (msg: any, name: string) =>
              (msg?.payload?.headers ?? []).find((h: any) => h.name === name)?.value ?? "";
            threadResults[tid] = {
              subject: getH(first, "Subject"),
              from: getH(last, "From"),
              to: getH(last, "To"),
              messageCount: msgs.length,
            };
          } catch { /* skip failed */ }
        }));
      }

      // Fetch messages (concurrently, max 10 at a time)
      const msgBatches = [];
      for (let i = 0; i < messageIds.length; i += 10) {
        msgBatches.push(messageIds.slice(i, i + 10));
      }
      for (const batch of msgBatches) {
        await Promise.all(batch.map(async (mid) => {
          try {
            const msg = await gmail.users.messages.get({
              userId: "me", id: mid, format: "metadata",
              metadataHeaders: ["From", "To", "Cc", "Subject"],
            });
            const headers = msg.data.payload?.headers ?? [];
            const getH = (name: string) => headers.find((h: any) => h.name === name)?.value ?? "";
            const from = getH("From");
            const to = getH("To");
            const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).toLowerCase();
            const isOurs = fromEmail === myEmail ||
              (domain && fromEmail.endsWith(`@${domain}`) && fromEmail.split("@")[0]?.startsWith(localPart + "+"));
            messageResults[mid] = {
              from, to, cc: getH("Cc"), subject: getH("Subject"),
              resolved_to: isOurs ? to : from,
            };
          } catch { /* skip failed */ }
        }));
      }

      res.json({ threads: threadResults, messages: messageResults });
    } catch (err) {
      console.error("Gmail batch headers error:", err);
      res.status(500).json({ error: "Failed to fetch headers" });
    }
  });

  // Gmail message headers (single message, for reply preview)
  app.get("/api/gmail/messages/:messageId/headers", async (req, res) => {
    try {
      const conn = await db.getConnection("gmail", (req as any).userId);
      if (!conn) return res.json({ error: "Gmail not connected" });

      const { google } = await import("googleapis");
      const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      auth.setCredentials(conn.credentials);
      const gmail = google.gmail({ version: "v1", auth });

      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = (profile.data.emailAddress ?? "").toLowerCase();

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: req.params.messageId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject"],
      });

      const headers = msg.data.payload?.headers ?? [];
      const getH = (name: string) => headers.find((h: any) => h.name === name)?.value ?? "";

      const from = getH("From");
      const to = getH("To");
      const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).toLowerCase();
      const [localPart, domain] = myEmail.split("@");
      const isOurs = fromEmail === myEmail ||
        (domain && fromEmail.endsWith(`@${domain}`) && fromEmail.split("@")[0]?.startsWith(localPart + "+"));

      res.json({
        from, to, cc: getH("Cc"), subject: getH("Subject"),
        resolved_to: isOurs ? to : from,
      });
    } catch (err) {
      console.error("Gmail message headers error:", err);
      res.status(500).json({ error: "Failed to fetch message headers" });
    }
  });

  // Gmail thread headers (single thread, for archive preview)
  app.get("/api/gmail/threads/:threadId/headers", async (req, res) => {
    try {
      const conn = await db.getConnection("gmail", (req as any).userId);
      if (!conn) return res.json({ error: "Gmail not connected" });

      const { google } = await import("googleapis");
      const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      auth.setCredentials(conn.credentials);
      const gmail = google.gmail({ version: "v1", auth });

      const thread = await gmail.users.threads.get({
        userId: "me",
        id: req.params.threadId,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To"],
      });

      const msgs = thread.data.messages ?? [];
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      const getH = (msg: any, name: string) =>
        (msg?.payload?.headers ?? []).find((h: any) => h.name === name)?.value ?? "";

      res.json({
        subject: getH(first, "Subject"),
        from: getH(last, "From"),
        to: getH(last, "To"),
        messageCount: msgs.length,
      });
    } catch (err: any) {
      if (err?.status === 404 || err?.code === 404) {
        res.status(404).json({ error: "Thread not found" });
      } else {
        console.error("Gmail thread headers error:", err?.message ?? err);
        res.status(500).json({ error: "Failed to fetch thread headers" });
      }
    }
  });

  // Gmail labels
  app.get("/api/gmail/labels", async (req, res) => {
    try {
      const conn = await db.getConnection("gmail", (req as any).userId);
      if (!conn) return res.json([]);
      const { google } = await import("googleapis");
      const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      auth.setCredentials(conn.credentials);
      const gmail = google.gmail({ version: "v1", auth });
      const resp = await gmail.users.labels.list({ userId: "me" });
      const labels = (resp.data.labels ?? [])
        .filter((l: any) => l.type === "user" || ["INBOX", "SENT", "IMPORTANT", "STARRED"].includes(l.id))
        .map((l: any) => ({ id: l.id, name: l.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      res.json(labels);
    } catch (err) {
      console.error("Gmail labels error:", err);
      res.json([]);
    }
  });

  // Gmail search threads (lightweight metadata via batch API)
  app.get("/api/gmail/search", async (req, res) => {
    try {
      const q = (req.query.q as string) || "";
      const labelId = req.query.labelId as string | undefined;
      if (!q && !labelId) return res.json([]);
      const conn = await db.getConnection("gmail", (req as any).userId);
      if (!conn) return res.json([]);
      const { google } = await import("googleapis");
      const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      auth.setCredentials(conn.credentials);
      const gmail = google.gmail({ version: "v1", auth });

      // List threads matching query and/or label
      const listParams: any = { userId: "me", maxResults: 20 };
      if (q) listParams.q = q;
      if (labelId) listParams.labelIds = [labelId];
      console.log("[gmail/search] params:", { q: q || "(none)", labelId: labelId || "(none)" });
      const listResp = await gmail.users.threads.list(listParams);
      const listedThreads = listResp.data.threads ?? [];
      console.log("[gmail/search] found", listedThreads.length, "threads");
      if (listedThreads.length === 0) return res.json([]);

      const snippetMap = new Map(listedThreads.map((t: any) => [t.id, t.snippet ?? ""]));

      // Batch fetch metadata — one HTTP request for all threads
      const accessToken = (await auth.getAccessToken()).token;
      const boundary = "batch_gmail_search";
      const batchBody = listedThreads.map((t: any, i: number) =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\n` +
        `GET /gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date\r\n`
      ).join("") + `--${boundary}--`;

      const batchResp = await fetch("https://www.googleapis.com/batch/gmail/v1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
        },
        body: batchBody,
      });

      const batchText = await batchResp.text();

      // Parse multipart batch response
      const threads: any[] = [];
      const responseBoundary = batchText.match(/--([^\r\n]+)/)?.[1];
      if (responseBoundary) {
        const parts = batchText.split(`--${responseBoundary}`).slice(1, -1);
        for (const part of parts) {
          const jsonMatch = part.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;
          try {
            const data = JSON.parse(jsonMatch[0]);
            if (data.error) continue;
            const msgs = data.messages ?? [];
            const first = msgs[0];
            const last = msgs[msgs.length - 1];
            const getH = (msg: any, name: string) =>
              (msg?.payload?.headers ?? []).find((h: any) => h.name === name)?.value ?? "";
            const hasAttachments = msgs.some((m: any) => {
              const check = (parts: any[]): boolean =>
                parts?.some((p: any) => p.filename || check(p.parts)) ?? false;
              return check(m.payload?.parts);
            });
            threads.push({
              threadId: data.id,
              subject: getH(first, "Subject"),
              from: getH(last, "From"),
              date: getH(last, "Date"),
              snippet: snippetMap.get(data.id) ?? last?.snippet ?? "",
              messageCount: msgs.length,
              hasAttachments,
            });
          } catch { /* skip malformed */ }
        }
      }
      console.log("[gmail/search] returning", threads.length, "threads after batch parse, status:", batchResp.status);
      if (threads.length === 0 && listedThreads.length > 0) {
        console.log("[gmail/search] batch parse failed! responseBoundary:", responseBoundary, "batchText length:", batchText.length, "first 500 chars:", batchText.slice(0, 500));
      }
      res.json(threads);
    } catch (err) {
      console.error("Gmail search error:", err);
      res.json([]);
    }
  });

  // Gmail thread attachments list
  app.get("/api/gmail/threads/:threadId/attachments", async (req, res) => {
    try {
      const conn = await db.getConnection("gmail", (req as any).userId);
      if (!conn) return res.json([]);
      const { google } = await import("googleapis");
      const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      auth.setCredentials(conn.credentials);
      const gmail = google.gmail({ version: "v1", auth });

      const thread = await gmail.users.threads.get({ userId: "me", id: req.params.threadId as string, format: "full" });
      const attachments: any[] = [];

      for (const msg of thread.data.messages ?? []) {
        const getH = (name: string) =>
          (msg.payload?.headers ?? []).find((h: any) => h.name === name)?.value ?? "";
        const findAtts = (parts: any[], acc: any[] = []) => {
          for (const part of parts ?? []) {
            if (part.body?.attachmentId && part.filename) {
              acc.push({
                messageId: msg.id,
                attachmentId: part.body.attachmentId,
                filename: part.filename,
                mimeType: part.mimeType,
                size: part.body.size ?? 0,
                from: getH("From"),
                date: getH("Date"),
              });
            }
            if (part.parts) findAtts(part.parts, acc);
          }
          return acc;
        };
        if (msg.payload?.parts) findAtts(msg.payload.parts, attachments);
        // Check single-part messages too
        if (msg.payload?.body?.attachmentId && msg.payload?.filename) {
          attachments.push({
            messageId: msg.id,
            attachmentId: msg.payload.body.attachmentId,
            filename: msg.payload.filename,
            mimeType: msg.payload.mimeType,
            size: msg.payload.body.size ?? 0,
            from: getH("From"),
            date: getH("Date"),
          });
        }
      }
      res.json(attachments);
    } catch (err) {
      console.error("Gmail attachments error:", err);
      res.json([]);
    }
  });

  // Settings (system prompt, etc.)
  app.get("/api/settings/:key", async (req, res) => {
    const value = await db.getSetting(req.params.key);
    res.json({ key: req.params.key, value });
  });

  app.put("/api/settings/:key", async (req, res) => {
    const { value } = req.body;
    await db.setSetting(req.params.key, value ?? "");
    res.json({ key: req.params.key, value });
  });

  // Chat logs
  app.get("/api/chat-logs", async (req, res) => {
    const ip = req.query.ip as string | undefined;
    const limit = parseInt(req.query.limit as string) || 200;
    const offset = parseInt(req.query.offset as string) || 0;
    const logs = await db.listChatLogs(ip ? { ip } : undefined, limit, offset);
    res.json(logs);
  });

  app.get("/api/chat-logs/ips", async (_req, res) => {
    const ips = await db.listChatLogIps();
    res.json(ips);
  });

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Serve frontend static files
  const frontendDir = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendDir));

  // SPA fallback — serve index.html for all non-API routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });

  return app;
}
