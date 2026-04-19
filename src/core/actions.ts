/**
 * Action executor — takes structured action JSON from the agent
 * and executes it directly via APIs (Gmail, Slack, etc.)
 *
 * The agent returns actions like:
 *   { action: "send_email", to: "x@y.com", subject: "...", body: "..." }
 *   { action: "send_slack", channel: "C123", text: "..." }
 *   { action: "reply_email", thread_id: "...", body: "..." }
 */

import * as db from "./db.js";

// ---- Attachment helpers ----

interface ResolvedAttachment {
  filename: string;
  content: Buffer;
  mime_type: string;
}

async function resolveAttachments(attachments?: Attachment[], userId?: string): Promise<ResolvedAttachment[]> {
  if (!attachments?.length) return [];
  const resolved: ResolvedAttachment[] = [];

  for (const att of attachments) {
    // If content is provided directly (base64)
    if (att.content) {
      resolved.push({
        filename: att.filename,
        content: Buffer.from(att.content, "base64"),
        mime_type: att.mime_type ?? "application/octet-stream",
      });
      continue;
    }

    // Resolve from source reference
    if (att.source?.startsWith("email:")) {
      const parts = att.source.split(":");
      const messageId = parts[1];
      const attachmentId = parts.slice(2).join(":"); // attachment IDs can contain colons
      try {
        const gmail = await getGmailClient(userId);
        const data = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attachmentId,
        });
        const raw = (data.data.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
        resolved.push({
          filename: att.filename,
          content: Buffer.from(raw, "base64"),
          mime_type: att.mime_type ?? "application/octet-stream",
        });
      } catch (err) {
        console.error(`[ATTACH] Failed to fetch Gmail attachment ${attachmentId}: ${err}`);
        throw new Error(`Failed to fetch email attachment "${att.filename}": ${err}`);
      }
    } else if (att.source?.startsWith("slack:")) {
      const fileUrl = att.source.slice(6);
      const conn = await db.getConnection("slack");
      const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error("No Slack token for file download");

      const res = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to download Slack file: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      resolved.push({
        filename: att.filename,
        content: buf,
        mime_type: att.mime_type ?? "application/octet-stream",
      });
    }
  }
  return resolved;
}

// ---- Action types ----

export interface Attachment {
  filename: string;
  /** Base64-encoded file content, OR a URL to fetch (email attachment URL, Slack file URL) */
  content?: string;
  /** Source reference: "email:<message_id>:<attachment_id>" or "slack:<file_url>" */
  source?: string;
  mime_type?: string;
}

export interface SendEmailAction {
  action: "send_email";
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Attachment[];
}

export interface ReplyEmailAction {
  action: "reply_email";
  thread_id: string;
  message_id?: string;
  to?: string[];      // If set, send to these addresses; otherwise reply to original sender
  body: string;
  reply_all?: boolean;
  cc?: string[];
  bcc?: string[];
  attachments?: Attachment[];
}

export interface ForwardEmailAction {
  action: "forward_email";
  thread_id: string;
  message_id: string;
  to: string[];
  body: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Attachment[];
}

export interface SendSlackAction {
  action: "send_slack";
  channel: string;
  text: string;
  thread_ts?: string;
  attachments?: Attachment[];
}

export interface EditSlackAction {
  action: "edit_slack";
  channel: string;
  message_ts: string;
  text: string;
}

export interface CustomAction {
  action: "custom";
  description: string;
}

export interface NoAction {
  action: "none";
  reason: string;
}

export interface ArchiveEmailAction {
  action: "archive_email";
  thread_id: string;
  thread_subject?: string;
  unarchive?: boolean;
}

export interface LabelEmailAction {
  action: "label_email";
  thread_id: string;
  label_name: string;
  thread_subject?: string;
  remove?: boolean;
}

export interface KnowledgeUpsertAction {
  action: "knowledge_upsert";
  type: string;
  match_on: string[];
  data: Record<string, any>;
  created_by?: string;
}

export type WorkflowAction = SendEmailAction | ReplyEmailAction | ForwardEmailAction | SendSlackAction | EditSlackAction | ArchiveEmailAction | LabelEmailAction | CustomAction | NoAction | KnowledgeUpsertAction;

// ---- Executor ----

export async function executeAction(action: WorkflowAction, userId?: string): Promise<string> {
  switch (action.action) {
    case "send_email":
      return executeSendEmail(action, userId);
    case "reply_email":
      return executeReplyEmail(action, userId);
    case "forward_email":
      return executeForwardEmail(action, userId);
    case "send_slack":
      return executeSendSlack(action, userId);
    case "edit_slack":
      return executeEditSlack(action, userId);
    case "archive_email":
      return executeArchiveEmail(action, userId);
    case "label_email":
      return executeLabelEmail(action, userId);
    case "custom":
      return `Manual action required: ${action.description}`;
    case "none":
      return `No action taken: ${action.reason}`;
    case "knowledge_upsert":
      return executeKnowledgeUpsert(action);
    default:
      throw new Error(`Unknown action type: ${(action as any).action}`);
  }
}

async function executeSendEmail(action: SendEmailAction, userId?: string): Promise<string> {
  const gmail = await getGmailClient(userId);
  const files = await resolveAttachments(action.attachments, userId);

  const headers = [
    `To: ${action.to.join(", ")}`,
    `Subject: ${action.subject}`,
    ...(action.cc?.length ? [`Cc: ${action.cc.join(", ")}`] : []),
    ...(action.bcc?.length ? [`Bcc: ${action.bcc.join(", ")}`] : []),
  ];

  // If thread_id is present, set proper threading headers so Gmail threads it correctly
  const threadId = (action as any).thread_id;
  if (threadId) {
    try {
      const thread = await gmail.users.threads.get({
        userId: "me", id: threadId, format: "metadata",
        metadataHeaders: ["Message-ID", "Subject"],
      });
      const lastMsg = (thread.data.messages ?? []).at(-1);
      const origMsgId = lastMsg?.payload?.headers?.find((h: any) => h.name === "Message-ID")?.value;
      if (origMsgId) {
        headers.push(`In-Reply-To: ${origMsgId}`);
        headers.push(`References: ${origMsgId}`);
      }
    } catch {}
  }

  const raw = files.length > 0
    ? buildMimeWithAttachments(headers, action.body, files)
    : encodeRaw([...headers, `Content-Type: text/plain; charset=utf-8`], action.body);

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, ...(threadId ? { threadId } : {}) },
  });

  const attNote = files.length > 0 ? ` (${files.length} attachment${files.length > 1 ? "s" : ""})` : "";
  return `Email sent to ${action.to.join(", ")}: "${action.subject}"${attNote}`;
}

export async function getGmailClient(userId?: string) {
  const conn = await db.getConnection("gmail", userId);
  if (!conn) throw new Error("Gmail not connected. Please connect Gmail in Settings → Connections.");

  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);

  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens }, userId);
  });

  return google.gmail({ version: "v1", auth });
}

/**
 * If the first message in the thread was sent from a plus-tagged version
 * of the account's default email (e.g. user+123@domain.com), return that
 * full From header so replies/forwards use the same sender.
 */
async function resolveThreadFromAddress(gmail: any, threadId: string): Promise<string | null> {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    const defaultEmail = (profile.data.emailAddress ?? "").toLowerCase();
    if (!defaultEmail) return null;

    const [localPart, domain] = defaultEmail.split("@");
    if (!localPart || !domain) return null;

    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From"],
    });
    const firstMsg = thread.data.messages?.[0];
    const firstFrom = firstMsg?.payload?.headers?.find((h: any) => h.name === "From")?.value;
    if (!firstFrom) return null;

    const emailMatch = firstFrom.match(/<([^>]+)>/);
    const email = (emailMatch ? emailMatch[1] : firstFrom).toLowerCase();

    // Check if it's localpart+something@domain (plus-tagged version of the account email)
    const plusRegex = new RegExp(`^${localPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+.+@${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    if (plusRegex.test(email)) {
      return firstFrom;
    }
  } catch {
    // Fall through
  }
  return null;
}

function encodeRaw(headerLines: string[], body: string): string {
  return Buffer.from(headerLines.join("\r\n") + "\r\n\r\n" + body)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildMimeWithAttachments(headerLines: string[], body: string, files: ResolvedAttachment[]): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const headers = [
    ...headerLines,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  let mime = headers.join("\r\n") + "\r\n\r\n";
  // Text body part
  mime += `--${boundary}\r\n`;
  mime += 'Content-Type: text/plain; charset="UTF-8"\r\n\r\n';
  mime += body + "\r\n";
  // Attachment parts
  for (const file of files) {
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: ${file.mime_type}; name="${file.filename}"\r\n`;
    mime += `Content-Disposition: attachment; filename="${file.filename}"\r\n`;
    mime += "Content-Transfer-Encoding: base64\r\n\r\n";
    mime += file.content.toString("base64") + "\r\n";
  }
  mime += `--${boundary}--`;

  return Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function executeReplyEmail(action: ReplyEmailAction, userId?: string): Promise<string> {
  const gmail = await getGmailClient(userId);
  const files = await resolveAttachments(action.attachments, userId);

  // If no message_id, look up the last message in the thread
  let messageId = action.message_id;
  if (!messageId) {
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: action.thread_id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID"],
    });
    const messages = thread.data.messages ?? [];
    if (messages.length === 0) throw new Error(`Thread ${action.thread_id} has no messages`);
    messageId = messages[messages.length - 1].id!;
  }

  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID"],
  });

  const origHeaders = original.data.payload?.headers ?? [];
  const getHeader = (name: string) => origHeaders.find((h) => h.name === name)?.value ?? "";

  const origFrom = getHeader("From");
  const origTo = getHeader("To");
  const origCc = getHeader("Cc");
  const origSubject = getHeader("Subject");
  const origMessageId = getHeader("Message-ID");

  const subject = origSubject.startsWith("Re: ") ? origSubject : `Re: ${origSubject}`;

  // Determine our own email so we can handle self-replies correctly
  const profile = await gmail.users.getProfile({ userId: "me" });
  const myEmail = (profile.data.emailAddress ?? "").toLowerCase();

  // Check if the original message was sent by us (including plus-tagged aliases)
  const origFromEmail = (origFrom.match(/<([^>]+)>/)?.[1] ?? origFrom).toLowerCase();
  const isOurMessage = origFromEmail === myEmail ||
    (myEmail && origFromEmail.split("@")[1] === myEmail.split("@")[1] &&
     origFromEmail.split("@")[0]?.startsWith(myEmail.split("@")[0] + "+"));

  // Check if agent's "to" is just our own address (common mistake when replying to our own outbound)
  const agentToIsUs = action.to?.length
    ? action.to.every((t) => {
        const e = (t.match(/<([^>]+)>/)?.[1] ?? t).toLowerCase();
        return e === myEmail || (myEmail && e.split("@")[1] === myEmail.split("@")[1] &&
          e.split("@")[0]?.startsWith(myEmail.split("@")[0] + "+"));
      })
    : false;

  // Use explicit to if provided (and not just our own address); if replying to our own message, send to original recipients
  let toAddr = (action.to?.length && !agentToIsUs)
    ? action.to.join(", ")
    : isOurMessage ? origTo : origFrom;
  let ccAddrs: string[] = action.cc ? [...action.cc] : [];

  if (action.reply_all || isOurMessage) {
    // When replying to our own message or reply-all: include all original recipients in Cc
    const allRecipients = [isOurMessage ? "" : origTo, origCc]
      .filter(Boolean)
      .join(", ")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => {
        if (!e) return false;
        const email = (e.match(/<([^>]+)>/)?.[1] ?? e).toLowerCase();
        // Exclude ourselves and whoever is already in To
        return !email.includes(myEmail) && !toAddr.toLowerCase().includes(email);
      });

    ccAddrs = [...ccAddrs, ...allRecipients];
  }

  const fromAddr = await resolveThreadFromAddress(gmail, action.thread_id);

  const headerLines = [
    ...(fromAddr ? [`From: ${fromAddr}`] : []),
    `To: ${toAddr}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${origMessageId}`,
    `References: ${origMessageId}`,
    ...(ccAddrs.length > 0 ? [`Cc: ${ccAddrs.join(", ")}`] : []),
    ...(action.bcc?.length ? [`Bcc: ${action.bcc.join(", ")}`] : []),
  ];

  const raw = files.length > 0
    ? buildMimeWithAttachments(headerLines, action.body, files)
    : encodeRaw([...headerLines, `Content-Type: text/plain; charset=utf-8`], action.body);

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: action.thread_id },
  });

  const mode = action.reply_all ? "Reply-all" : "Reply";
  const attNote = files.length > 0 ? ` (${files.length} attachment${files.length > 1 ? "s" : ""})` : "";
  return `${mode} sent to ${toAddr}${ccAddrs.length > 0 ? ` (cc: ${ccAddrs.join(", ")})` : ""} in thread ${action.thread_id}${attNote}`;
}

async function executeForwardEmail(action: ForwardEmailAction, userId?: string): Promise<string> {
  const gmail = await getGmailClient(userId);
  const files = await resolveAttachments(action.attachments, userId);

  const original = await gmail.users.messages.get({
    userId: "me",
    id: action.message_id,
    format: "metadata",
    metadataHeaders: ["From", "To", "Date", "Subject", "Message-ID"],
  });

  const origHeaders = original.data.payload?.headers ?? [];
  const getHeader = (name: string) => origHeaders.find((h) => h.name === name)?.value ?? "";

  const origSubject = getHeader("Subject");
  const origMessageId = getHeader("Message-ID");
  const subject = origSubject.startsWith("Fwd: ") ? origSubject : `Fwd: ${origSubject}`;

  const fwdFromAddr = await resolveThreadFromAddress(gmail, action.thread_id);

  const headerLines = [
    ...(fwdFromAddr ? [`From: ${fwdFromAddr}`] : []),
    `To: ${action.to.join(", ")}`,
    `Subject: ${subject}`,
    `References: ${origMessageId}`,
    ...(action.cc?.length ? [`Cc: ${action.cc.join(", ")}`] : []),
    ...(action.bcc?.length ? [`Bcc: ${action.bcc.join(", ")}`] : []),
  ];

  const forwardHeader = `---------- Forwarded message ----------\nFrom: ${getHeader("From")}\nDate: ${getHeader("Date")}\nSubject: ${origSubject}\nTo: ${getHeader("To")}\n\n`;
  const body = action.body + "\n\n" + forwardHeader;

  const raw = files.length > 0
    ? buildMimeWithAttachments(headerLines, body, files)
    : encodeRaw([...headerLines, `Content-Type: text/plain; charset=utf-8`], body);

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: action.thread_id },
  });

  const attNote = files.length > 0 ? ` (${files.length} attachment${files.length > 1 ? "s" : ""})` : "";
  return `Forwarded to ${action.to.join(", ")}${action.cc?.length ? ` (cc: ${action.cc.join(", ")})` : ""} from thread ${action.thread_id}${attNote}`;
}

async function executeSendSlack(action: SendSlackAction, userId?: string): Promise<string> {
  // Prefer user token (posts as the user) over bot token
  const conn = await db.getConnection("slack", userId);
  const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Slack not connected and no bot token configured.");

  const files = await resolveAttachments(action.attachments, userId);

  // Upload files first if any
  const fileIds: string[] = [];
  for (const file of files) {
    // Step 1: Get upload URL
    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename: file.filename,
        length: String(file.content.length),
      }),
    });
    const urlData = await urlRes.json() as any;
    if (!urlData.ok) throw new Error(`Slack upload URL error: ${urlData.error}`);

    // Step 2: Upload file content
    const uploadRes = await fetch(urlData.upload_url, {
      method: "POST",
      headers: { "Content-Type": file.mime_type },
      body: new Uint8Array(file.content),
    });
    if (!uploadRes.ok) throw new Error(`Slack file upload failed: ${uploadRes.status} ${uploadRes.statusText}`);

    fileIds.push(urlData.file_id);
  }

  // Step 3: Complete uploads and attach to channel/thread
  if (fileIds.length > 0) {
    const completeBody: any = {
      files: fileIds.map((id) => ({ id })),
      channel_id: action.channel,
    };
    if (action.text) completeBody.initial_comment = action.text;
    if (action.thread_ts) completeBody.thread_ts = action.thread_ts;

    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(completeBody),
    });
    const completeData = await completeRes.json() as any;
    if (!completeData.ok) throw new Error(`Slack complete upload error: ${completeData.error}`);
  } else {
    // Text-only message
    const body: Record<string, string> = {
      channel: action.channel,
      text: action.text,
    };
    if (action.thread_ts) body.thread_ts = action.thread_ts;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  }

  const attNote = files.length > 0 ? ` (${files.length} file${files.length > 1 ? "s" : ""})` : "";
  return `Slack message sent to ${action.channel}${attNote}`;
}

async function executeEditSlack(action: EditSlackAction, userId?: string): Promise<string> {
  const conn = await db.getConnection("slack", userId);
  const token = conn?.credentials?.user_token || process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Slack not connected and no bot token configured.");

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: action.channel,
      ts: action.message_ts,
      text: action.text,
    }),
  });

  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);

  return `Slack message edited in ${action.channel}`;
}

async function executeArchiveEmail(action: ArchiveEmailAction, userId?: string): Promise<string> {
  const gmail = await getGmailClient(userId);
  try {
    await gmail.users.threads.modify({
      userId: "me",
      id: action.thread_id,
      requestBody: action.unarchive
        ? { addLabelIds: ["INBOX"] }
        : { removeLabelIds: ["INBOX"] },
    });
  } catch (err: any) {
    if (err?.code === 412 || err?.status === 412) {
      return action.unarchive
        ? `Already in inbox: ${action.thread_id}`
        : `Already archived (or not in inbox): ${action.thread_id}`;
    }
    throw err;
  }
  return action.unarchive
    ? `Unarchived email thread ${action.thread_id}`
    : `Archived email thread ${action.thread_id}`;
}

async function executeLabelEmail(action: LabelEmailAction, userId?: string): Promise<string> {
  const gmail = await getGmailClient(userId);

  // Look up the label by name (or use directly if it looks like an ID)
  let labelId = action.label_name;
  if (!action.label_name.startsWith("Label_") && !["INBOX", "SENT", "IMPORTANT", "STARRED", "TRASH", "SPAM"].includes(action.label_name)) {
    const resp = await gmail.users.labels.list({ userId: "me" });
    const label = (resp.data.labels ?? []).find(
      (l: any) => l.name?.toLowerCase() === action.label_name.toLowerCase()
    );
    if (!label) {
      // Create the label if it doesn't exist
      const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: { name: action.label_name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      });
      labelId = created.data.id!;
    } else {
      labelId = label.id!;
    }
  }

  await gmail.users.threads.modify({
    userId: "me",
    id: action.thread_id,
    requestBody: action.remove
      ? { removeLabelIds: [labelId] }
      : { addLabelIds: [labelId] },
  });

  return action.remove
    ? `Removed label "${action.label_name}" from thread ${action.thread_id}`
    : `Added label "${action.label_name}" to thread ${action.thread_id}`;
}

async function executeKnowledgeUpsert(action: KnowledgeUpsertAction): Promise<string> {
  const record = await db.upsertKnowledge(action.type, action.match_on, action.data, action.created_by || "agent");
  return `Knowledge upserted: ${action.type} (id: ${record.id})`;
}

// ---- Parse agent output ----

export function parseAgentActions(agentOutput: string): { summary: string; actions: WorkflowAction[] } {
  // Try to extract JSON actions from agent output
  // Agent is prompted to return JSON between ```json blocks
  const jsonMatch = agentOutput.match(/```json\s*([\s\S]*?)```/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      const actions: WorkflowAction[] = Array.isArray(parsed) ? parsed : [parsed];
      // Everything before the JSON block is the summary
      const summary = agentOutput.slice(0, agentOutput.indexOf("```json")).trim();
      return { summary: summary || "Action plan ready.", actions };
    } catch {
      // Fall through to no-action
    }
  }

  // If no JSON found, treat the whole output as a summary with no executable actions
  return { summary: agentOutput, actions: [] };
}

// ---- Action description for UI ----

export function describeAction(action: WorkflowAction): string {
  switch (action.action) {
    case "send_email": {
      const att = action.attachments?.length ? ` +${action.attachments.length} file${action.attachments.length > 1 ? "s" : ""}` : "";
      return `Send email to ${action.to.join(", ")}: "${action.subject}"${att}`;
    }
    case "reply_email": {
      const mode = action.reply_all ? "Reply-all" : "Reply";
      const to = action.to?.length ? ` to ${action.to.join(", ")}` : ` in thread ${action.thread_id}`;
      const cc = action.cc?.length ? ` (cc: ${action.cc.join(", ")})` : "";
      const bcc = action.bcc?.length ? ` (bcc: ${action.bcc.join(", ")})` : "";
      const att = action.attachments?.length ? ` +${action.attachments.length} file${action.attachments.length > 1 ? "s" : ""}` : "";
      return `${mode}${to}${cc}${bcc}${att}`;
    }
    case "forward_email": {
      const att = action.attachments?.length ? ` +${action.attachments.length} file${action.attachments.length > 1 ? "s" : ""}` : "";
      return `Forward thread ${action.thread_id} to ${action.to.join(", ")}${att}`;
    }
    case "send_slack": {
      const att = action.attachments?.length ? ` +${action.attachments.length} file${action.attachments.length > 1 ? "s" : ""}` : "";
      return `Send Slack message to ${action.channel}${att}`;
    }
    case "edit_slack":
      return `Edit Slack message in ${action.channel}`;
    case "archive_email":
      return `Archive email thread${action.thread_subject ? `: ${action.thread_subject}` : ` ${action.thread_id}`}`;
    case "custom":
      return `Manual: ${action.description}`;
    case "none":
      return `No action: ${action.reason}`;
    case "knowledge_upsert":
      return `Knowledge upsert: ${action.type} (match: ${action.match_on.join(", ")})`;
    default:
      return `Unknown action: ${(action as any).action}`;
  }
}
