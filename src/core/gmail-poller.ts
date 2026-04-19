/**
 * Gmail Poll Trigger — periodically checks for new messages
 * matching each gmail_poll workflow's query, and triggers runs
 * for new messages since the last poll.
 *
 * Uses Gmail historyId as a high-water mark for efficient polling.
 */

import * as db from "./db.js";
import { runWorkflow } from "./runner.js";
import { extractBody } from "./list-fetchers.js";

const POLL_INTERVAL_MS = 60_000; // 1 minute default
let pollTimer: ReturnType<typeof setInterval> | null = null;

export async function startGmailPoller(): Promise<void> {
  console.log("Gmail poller starting...");
  // Run immediately, then on interval
  await pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
}

export function stopGmailPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function getGmailClient() {
  const conn = await db.getConnection("gmail");
  if (!conn) return null;

  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  return google.gmail({ version: "v1", auth });
}

async function pollAll(): Promise<void> {
  try {
    const workflows = await db.getWorkflowsByTrigger("gmail_poll");
    if (workflows.length === 0) return;

    const gmail = await getGmailClient();
    if (!gmail) {
      console.log("[GMAIL_POLL] Gmail not connected, skipping");
      return;
    }

    for (const workflow of workflows) {
      try {
        await pollWorkflow(gmail, workflow);
      } catch (err) {
        console.error(`[GMAIL_POLL] Error polling workflow "${workflow.name}":`, err);
      }
    }
  } catch (err) {
    console.error("[GMAIL_POLL] Error in poll cycle:", err);
  }
}

async function pollWorkflow(gmail: any, workflow: any): Promise<void> {
  const query: string = workflow.trigger_config.query || "";
  const settingKey = `gmail_poll_history_${workflow.id}`;

  // Get stored historyId
  const storedHistoryId = await db.getSetting(settingKey);

  if (!storedHistoryId) {
    // First poll — seed the high-water mark without triggering
    // Get current historyId from profile
    const profile = await gmail.users.getProfile({ userId: "me" });
    const currentHistoryId = profile.data.historyId;
    if (currentHistoryId) {
      await db.setSetting(settingKey, currentHistoryId);
      console.log(`[GMAIL_POLL] Seeded historyId for "${workflow.name}": ${currentHistoryId}`);
    }
    return;
  }

  // Use history.list to find new messages since last poll
  let newMessageIds: string[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const history = await gmail.users.history.list({
        userId: "me",
        startHistoryId: storedHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
      });

      for (const record of history.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) {
            newMessageIds.push(added.message.id);
          }
        }
      }

      // Update high-water mark
      if (history.data.historyId) {
        await db.setSetting(settingKey, history.data.historyId);
      }

      pageToken = history.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    // 404 means historyId is too old — reseed
    if (err.code === 404 || err.status === 404) {
      console.log(`[GMAIL_POLL] historyId expired for "${workflow.name}", reseeding`);
      const profile = await gmail.users.getProfile({ userId: "me" });
      if (profile.data.historyId) {
        await db.setSetting(settingKey, profile.data.historyId);
      }
      return;
    }
    throw err;
  }

  if (newMessageIds.length === 0) return;

  // Deduplicate
  newMessageIds = [...new Set(newMessageIds)];

  // Filter by query if specified — history.list returns ALL new messages,
  // so we need to check each against the workflow's query
  const queryMatchCache = new Set<string>();
  const matchingMessages: Record<string, any>[] = [];

  for (const msgId of newMessageIds) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "full",
      });

      // If there's a query filter, verify this message matches
      // by checking if it appears in search results for the query
      if (query && !queryMatchCache.has(msgId)) {
        // Batch check: on first message, fetch all IDs matching the query
        // and cache them for the rest of this poll cycle
        if (queryMatchCache.size === 0) {
          const search = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 500,
          });
          for (const m of search.data.messages ?? []) {
            queryMatchCache.add(m.id!);
          }
        }
        if (!queryMatchCache.has(msgId)) continue;
      }

      const headers = msg.data.payload?.headers ?? [];
      const h = (name: string) => headers.find((h: any) => h.name === name)?.value ?? "";

      matchingMessages.push({
        id: msgId,
        threadId: msg.data.threadId,
        from: h("From"),
        to: h("To"),
        cc: h("Cc"),
        subject: h("Subject"),
        date: h("Date"),
        message_id: h("Message-ID"),
        snippet: msg.data.snippet ?? "",
        body: extractBody(msg.data.payload),
        labelIds: msg.data.labelIds ?? [],
      });
    } catch (err) {
      console.error(`[GMAIL_POLL] Error fetching message ${msgId}:`, err);
    }
  }

  if (matchingMessages.length === 0) return;

  console.log(`[GMAIL_POLL] "${workflow.name}": ${matchingMessages.length} new message(s) match query`);

  // Trigger a workflow run for each new message
  // (or batch them — one run with all messages as items)
  const batchMode = workflow.trigger_config.batch !== false; // default: batch

  if (batchMode && matchingMessages.length > 0) {
    // Single run with all messages — workflow's list_source is skipped,
    // triggerData feeds directly into the runner
    const run = await db.createRun(workflow.id, "gmail_poll");
    runWorkflow(workflow, run, matchingMessages.length === 1 ? matchingMessages[0] : { messages: matchingMessages }).catch((err) =>
      console.error(`[GMAIL_POLL] Workflow "${workflow.name}" failed:`, err),
    );
  } else {
    // One run per message
    for (const msg of matchingMessages) {
      const run = await db.createRun(workflow.id, "gmail_poll");
      runWorkflow(workflow, run, msg).catch((err) =>
        console.error(`[GMAIL_POLL] Workflow "${workflow.name}" failed for msg ${msg.id}:`, err),
      );
    }
  }
}
