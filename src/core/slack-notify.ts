import type { ExecutionItem, Workflow } from "./types.js";
import { getGmailClient } from "./actions.js";
import * as db from "./db.js";

const SLACK_MSG_LIMIT = 4000;
const MAX_THREAD_MSGS = 5;

type Block = Record<string, any>;

/** Post a message to Slack, returns the message ts (for threading). */
export async function slackPost(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  blocks?: Block[],
): Promise<string | null> {
  const body: Record<string, any> = { channel, text, unfurl_links: false, unfurl_media: false };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks) body.blocks = blocks;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!data.ok) {
    console.error(`[SLACK] chat.postMessage failed: ${data.error}`, { channel, text: text.slice(0, 100) });
  }
  return data.ok ? data.ts ?? null : null;
}

/** Update an existing Slack message. */
async function slackUpdate(token: string, channel: string, ts: string, text: string, blocks?: Block[]): Promise<boolean> {
  const body: Record<string, any> = { channel, ts, text };
  if (blocks) body.blocks = blocks;

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  return data.ok;
}

// ── Block Kit helpers ──

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) } };
}

function context(...texts: string[]): Block {
  return { type: "context", elements: texts.map((t) => ({ type: "mrkdwn", text: t.slice(0, 3000) })) };
}

function divider(): Block {
  return { type: "divider" };
}

function fields(pairs: [string, string][]): Block {
  return {
    type: "section",
    fields: pairs.map(([label, value]) => ({
      type: "mrkdwn",
      text: `*${label}*\n${value}`.slice(0, 2000),
    })),
  };
}

// ── Data formatters ──

/** Derive a short label for an item from its data. */
export function itemLabel(data: Record<string, any> | undefined, index: number): string {
  if (!data) return `Item ${index}`;
  const candidates = [
    data.name, data.title, data.subject,
    data.from && data.subject ? `${data.from.split("<")[0].trim()} — ${data.subject}` : null,
    data.from, data.email, data.id,
  ];
  for (const c of candidates) {
    if (c && typeof c === "string" && c.trim()) {
      const label = c.trim();
      return label.length > 80 ? label.slice(0, 77) + "…" : label;
    }
  }
  return `Item ${index}`;
}

/** One-line action gist for the top-level item message. */
export function actionGist(actions: Array<{ action: string; [k: string]: any }>): string {
  if (!actions || actions.length === 0) return "No action";
  const att = (a: any) => a.attachments?.length ? ` +${a.attachments.length} file${a.attachments.length > 1 ? "s" : ""}` : "";
  const status = (a: any) => a._status === "failed" ? " ❌" : a._status === "executed" ? " ✅" : "";
  return actions
    .map((a) => {
      const s = status(a);
      switch (a.action) {
        case "send_email":
          return `📤 Send → ${Array.isArray(a.to) ? a.to.join(", ") : a.to}: "${a.subject || ""}"${att(a)}${s}`;
        case "reply_email": {
          let replyTo = Array.isArray(a.to) ? a.to.join(", ") : a.to || "";
          if (!replyTo && a._result) {
            const m = (a._result as string).match(/sent to (.+?) in thread/);
            if (m) replyTo = m[1];
          }
          return `↩️ Reply → ${replyTo || "thread"}${att(a)}${s}`;
        }
        case "forward_email":
          return `➡️ Forward → ${Array.isArray(a.to) ? a.to.join(", ") : a.to}${att(a)}${s}`;
        case "archive_email":
          return `📦 Archive${a._subject ? ` — ${a._subject}` : ""}${s}`;
        case "send_slack":
          return `💬 Slack → <#${a.channel}>${att(a)}${s}`;
        case "knowledge_upsert":
          return `📚 Update ${a.type}${s}`;
        case "custom":
          return `🔧 Manual: ${(a.description || "").slice(0, 80)}${s}`;
        case "none":
          return `⏭️ Skip: ${(a.reason || "").slice(0, 80)}`;
        default:
          return `${a.action}${s}`;
      }
    })
    .join("\n");
}

/** Detailed action breakdown for thread replies. */
export function summarizeActions(actions: Array<{ action: string; [k: string]: any }>): string {
  if (!actions || actions.length === 0) return "No action";
  const attLine = (a: any) => {
    if (!a.attachments?.length) return "";
    const names = a.attachments.map((f: any) => f.filename).join(", ");
    return `\nAttachments: ${names}`;
  };
  return actions
    .map((a) => {
      const quote = (s: string) => s ? `>${s.replace(/\n/g, "\n>")}` : "";
      switch (a.action) {
        case "send_email":
          return `*Send email* → ${Array.isArray(a.to) ? a.to.join(", ") : a.to}${a.subject ? `\nSubject: ${a.subject}` : ""}${attLine(a)}\n${quote(a.body || "")}`;
        case "reply_email": {
          const gmailLink = a.thread_id ? ` (<https://mail.google.com/mail/u/0/#inbox/${a.thread_id}|view thread>)` : "";
          return `*Reply email* → ${Array.isArray(a.to) ? a.to.join(", ") : a.to || "thread"}${gmailLink}${attLine(a)}\n${quote(a.body || "")}`;
        }
        case "forward_email": {
          const fwdLink = a.thread_id ? ` (<https://mail.google.com/mail/u/0/#inbox/${a.thread_id}|view thread>)` : "";
          return `*Forward email* → ${Array.isArray(a.to) ? a.to.join(", ") : a.to}${fwdLink}${attLine(a)}\n${quote(a.body || "")}`;
        }
        case "archive_email":
          return `*Archive* thread ${a.thread_id || ""}`;
        case "send_slack":
          return `*Slack msg* → <#${a.channel}>${attLine(a)}\n${quote(a.text || "")}`;
        case "knowledge_upsert":
          return `*Knowledge upsert* → ${a.type} (${Array.isArray(a.match_on) ? a.match_on.join(", ") : a.match_on})`;
        case "custom":
          return `*Manual action:* ${a.description || ""}`;
        case "none":
          return `No action: ${a.reason || "—"}`;
        default:
          return a.action;
      }
    })
    .join("\n\n");
}

/** Extract the agent's reasoning summary (text before the ```json block). */
export function agentSummary(agentResult: string | null): string {
  if (!agentResult) return "";
  const idx = agentResult.indexOf("```json");
  const summary = idx >= 0 ? agentResult.slice(0, idx).trim() : agentResult.trim();
  return summary;
}

/** Build the thought process text from agent steps. */
function buildThoughtProcess(steps: Array<{ type: string; data: string }> | undefined): string {
  if (!steps || steps.length === 0) return "";
  const parts: string[] = [];
  for (const step of steps) {
    if (step.type === "thinking") {
      parts.push(`💭 ${step.data}`);
    } else if (step.type === "text") {
      parts.push(`💬 ${step.data}`);
    } else if (step.type === "tool_call") {
      parts.push(`🔧 ${step.data}`);
    }
  }
  return parts.join("\n");
}

/** Build Block Kit blocks for an action. */
function actionBlocks(a: { action: string; [k: string]: any }): Block[] {
  const blocks: Block[] = [];
  const gmailLink = (threadId: string) => `<https://mail.google.com/mail/u/0/#inbox/${threadId}|View in Gmail>`;

  switch (a.action) {
    case "reply_email":
    case "send_email":
    case "forward_email": {
      const icon = a.action === "reply_email" ? "↩️" : a.action === "forward_email" ? "➡️" : "📤";
      const label = a.action === "reply_email" ? "Reply" : a.action === "forward_email" ? "Forward" : "Send";
      // For reply_email, `to` may be empty — extract from execution result if available
      let to = Array.isArray(a.to) ? a.to.join(", ") : a.to || "";
      if (!to && a._result) {
        const m = (a._result as string).match(/sent to (.+?) in thread/);
        if (m) to = m[1];
      }
      to = to || "thread";
      const headerParts: [string, string][] = [["To", to]];
      if (a.subject || a._subject) headerParts.push(["Subject", a.subject || a._subject]);
      if (a.thread_id) headerParts.push(["Thread", gmailLink(a.thread_id)]);

      blocks.push(section(`${icon} *${label} Email*`));
      blocks.push(fields(headerParts));
      if (a.body) {
        const body = a.body.length > 2500 ? a.body.slice(0, 2500) + "…" : a.body;
        blocks.push(section(`\`\`\`${body}\`\`\``));
      }
      break;
    }
    case "archive_email": {
      const subj = a._subject ? `\n_${a._subject}_` : "";
      blocks.push(section(`📦 *Archive Email*${subj}\n${a.thread_id ? gmailLink(a.thread_id) : "thread"}`));
      break;
    }
    case "send_slack":
      blocks.push(section(`💬 *Slack Message* → <#${a.channel}>`));
      if (a.text) {
        const text = a.text.length > 2500 ? a.text.slice(0, 2500) + "…" : a.text;
        blocks.push(section(`>${text.replace(/\n/g, "\n>")}`));
      }
      break;
    case "knowledge_upsert":
      blocks.push(section(`📚 *Knowledge Update* — ${a.type}\nMatch: ${Array.isArray(a.match_on) ? a.match_on.join(", ") : a.match_on}`));
      break;
    case "none":
      blocks.push(context(`⏭️ No action: ${a.reason || "—"}`));
      break;
    default:
      blocks.push(section(`🔧 *${a.action}*`));
  }
  return blocks;
}

/**
 * Enrich actions with Gmail thread metadata (subject, recipients).
 * Fetches thread info with 1s spacing to avoid quota issues.
 */
async function enrichActionsWithGmail(actions: Array<{ action: string; [k: string]: any }>): Promise<void> {
  const threadIds = new Set<string>();
  for (const a of actions) {
    if (a.thread_id && ["reply_email", "forward_email", "archive_email"].includes(a.action)) {
      threadIds.add(a.thread_id);
    }
  }
  if (threadIds.size === 0) return;

  let gmail: any;
  try {
    gmail = await getGmailClient();
  } catch {
    return; // Gmail not connected, skip enrichment
  }

  const cache = new Map<string, { subject: string; from: string; to: string }>();
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const threadId of threadIds) {
    try {
      if (cache.size > 0) await pause(1000);
      const res = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To"],
      });
      const msgs = res.data.messages ?? [];
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      const getH = (msg: any, name: string) =>
        (msg?.payload?.headers ?? []).find((h: any) => h.name === name)?.value ?? "";
      cache.set(threadId, {
        subject: getH(first, "Subject"),
        from: getH(last, "From"),
        to: getH(last, "To"),
      });
    } catch {
      // Skip on error — notification still works without enrichment
    }
  }

  // Apply enrichment to actions
  for (const a of actions) {
    if (!a.thread_id || !cache.has(a.thread_id)) continue;
    const info = cache.get(a.thread_id)!;
    if (!a._subject) a._subject = info.subject;
    if (!a.to && a.action !== "archive_email") {
      // After execution the last message is our own reply, so info.from is us.
      // Use info.to — the To header of the sent reply — which is the actual recipient.
      a.to = info.to;
    }
    if (a.action === "archive_email") {
      a._subject = info.subject;
    }
  }
}

/**
 * Send a Slack notification for an executed item.
 * Top-level: Block Kit message with summary + action list
 * Thread: Action details + agent thought process
 */
export async function notifyItemExecution(
  channel: string,
  item: ExecutionItem,
  opts: {
    approvedBy?: string;
    autoExecuted?: boolean;
    workflowName?: string;
  } = {},
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !channel) return;

  const actions = item.agent_actions ?? [];
  await enrichActionsWithGmail(actions);
  const label = itemLabel(item.item_data, 1);
  const gist = actionGist(actions);

  // Check action status for display
  const allDone = actions.every((a: any) => a._status === "executed" || a.action === "none");
  const failedCount = actions.filter((a: any) => a._status === "failed").length;

  // Build top-level Block Kit message
  let prefix: string;
  if (failedCount > 0) {
    prefix = `:warning: ${failedCount} action${failedCount > 1 ? "s" : ""} failed`;
    if (opts.approvedBy) prefix += ` (approved by ${opts.approvedBy})`;
  } else if (opts.approvedBy) {
    prefix = `:white_check_mark: Approved by ${opts.approvedBy}`;
  } else if (opts.autoExecuted) {
    prefix = `:robot_face: Auto-executed`;
  } else {
    prefix = `:white_check_mark: Executed`;
  }

  const workflowTag = opts.workflowName ? `  ·  _${opts.workflowName}_` : "";
  const fallbackText = `${prefix} — ${label}`;

  const summary = agentSummary(item.agent_result);

  const topBlocks: Block[] = [
    section(`*${label}*`),
    context(`${prefix}${workflowTag}`),
  ];
  if (summary) {
    topBlocks.push(section(summary.length > 2500 ? summary.slice(0, 2500) + "…" : summary));
  }
  topBlocks.push(divider(), section(gist));

  // If we already posted a notification for this item, update it instead
  let parentTs: string | null = null;
  if (item.slack_notify_ts && item.slack_notify_channel === channel) {
    await slackUpdate(token, channel, item.slack_notify_ts, fallbackText, topBlocks);
    parentTs = item.slack_notify_ts;
  } else {
    parentTs = await slackPost(token, channel, fallbackText, undefined, topBlocks);
    if (parentTs) {
      // Save the ts so we can update later on retry
      await db.updateItem(item.id, { slack_notify_ts: parentTs, slack_notify_channel: channel });
    }
  }
  if (!parentTs) return;

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Thread reply 1: detailed action breakdown with Block Kit
  await pause(500);
  const detailBlocks: Block[] = [section("*Action Details*"), divider()];
  const realActions = actions.filter((a) => a.action !== "none");
  const skipActions = actions.filter((a) => a.action === "none");

  for (let i = 0; i < realActions.length; i++) {
    detailBlocks.push(...actionBlocks(realActions[i]));
    if (i < realActions.length - 1) detailBlocks.push(divider());
  }

  if (skipActions.length > 0) {
    detailBlocks.push(divider());
    const skipReasons = skipActions.map((a) => `• ${a.reason || "—"}`).join("\n");
    detailBlocks.push(context(`*Skipped (${skipActions.length}):*\n${skipReasons}`));
  }

  // Slack limits blocks to 50 per message
  await slackPost(token, channel, "Action details", parentTs, detailBlocks.slice(0, 50));

  // Thread replies 2-N: agent thought process (plain text, split across messages)
  const reasoning = agentSummary(item.agent_result);
  const thoughtProcess = buildThoughtProcess(item.agent_steps as any);
  const fullThought = (reasoning ? `*Agent Summary*\n${reasoning}\n\n` : "") +
    (thoughtProcess ? `*Thought Process*\n${thoughtProcess}` : "");

  if (fullThought.trim()) {
    const chunks: string[] = [];
    let remaining = fullThought;
    while (remaining.length > 0 && chunks.length < MAX_THREAD_MSGS) {
      if (remaining.length <= SLACK_MSG_LIMIT) {
        chunks.push(remaining);
        break;
      }
      let breakAt = remaining.lastIndexOf("\n", SLACK_MSG_LIMIT);
      if (breakAt < SLACK_MSG_LIMIT * 0.5) breakAt = SLACK_MSG_LIMIT;
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }

    for (const chunk of chunks) {
      await pause(500);
      await slackPost(token, channel, chunk, parentTs);
    }
  }
}
