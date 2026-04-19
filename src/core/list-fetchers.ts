import * as db from "./db.js";
import { runAgentHeadless, type AgentStep } from "./agent.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_AUTH = process.env.SUPABASE_AUTH_TOKEN || process.env.SUPABASE_ANON_KEY!;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchList(
  source: string | null,
  config: Record<string, any>,
  onStep?: (step: AgentStep) => void,
): Promise<Record<string, any>[]> {
  if (!source) return [];

  switch (source) {
    case "supabase":
      return fetchSupabase(config);
    case "airtable":
      return fetchAirtable(config);
    case "gmail":
      return fetchGmail(config);
    case "slack":
      return fetchSlack(config);
    case "ai":
      return fetchAI(config, onStep);
    default:
      throw new Error(`Unknown list source: ${source}`);
  }
}

// Lightweight count — avoids fetching full message bodies (Gmail)
export async function fetchListCount(
  source: string | null,
  config: Record<string, any>
): Promise<number> {
  if (!source) return 0;
  if (source === "ai") return -1; // AI lists can't be cheaply counted
  if (source === "gmail") return countGmail(config);
  // Other sources are cheap enough to fetch fully
  const items = await fetchList(source, config);
  return items.length;
}

async function fetchSupabase(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { table, filter, filters = {}, order, select, schema } = config;

  // Parse filter string (e.g. "status=eq.new&internal_status=neq.test") into object
  const parsedFilters: Record<string, string> = { ...filters };
  if (typeof filter === "string" && filter.trim()) {
    for (const part of filter.split("&")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        parsedFilters[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
      }
    }
  }

  // PostgREST default limit is 1000 per page — paginate to get all rows
  const allRows: Record<string, any>[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    if (select) url.searchParams.set("select", select);
    for (const [key, val] of Object.entries(parsedFilters)) {
      url.searchParams.set(key, String(val));
    }
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    if (order) url.searchParams.set("order", order);

    const headers: Record<string, string> = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_AUTH}`,
        Prefer: "count=exact",
    };
    if (schema) {
      headers["Accept-Profile"] = schema;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Supabase fetch: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    allRows.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return allRows;
}

async function fetchAirtable(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { base_id, table, view, formula } = config;
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) throw new Error("AIRTABLE_API_KEY not set");

  const allRecords: Record<string, any>[] = [];
  let airtableOffset: string | undefined;

  do {
    const url = new URL(`https://api.airtable.com/v0/${base_id}/${encodeURIComponent(table)}`);
    if (view) url.searchParams.set("view", view);
    if (formula) url.searchParams.set("filterByFormula", formula);
    url.searchParams.set("pageSize", "100");
    if (airtableOffset) url.searchParams.set("offset", airtableOffset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Airtable fetch: ${res.status} ${await res.text()}`);
    const data = await res.json();
    allRecords.push(...(data.records ?? []).map((r: any) => ({ id: r.id, ...r.fields })));
    airtableOffset = data.offset;
    if (airtableOffset) await delay(200);
  } while (airtableOffset);

  return allRecords;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPlaceholderText(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return lower.includes("enable html") ||
    lower.includes("view this email") ||
    lower.includes("html to view") ||
    (lower.length < 200 && lower.includes("html"));
}

export function extractHtmlBody(payload: any): string | null {
  if (!payload) return null;

  // Single-part HTML message
  if (payload.body?.data && !payload.parts?.length) {
    if (payload.mimeType === "text/html") {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }
    return null;
  }

  // Multipart — find text/html part
  const parts: any[] = payload.parts ?? [];
  let htmlPart: any = null;

  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      htmlPart = part;
    } else if (part.parts) {
      for (const sub of part.parts) {
        if (sub.mimeType === "text/html" && sub.body?.data && !htmlPart) {
          htmlPart = sub;
        } else if (sub.parts) {
          const nested = extractHtmlBody(sub);
          if (nested) return nested;
        }
      }
    }
  }

  if (htmlPart?.body?.data) {
    return Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
  }
  return null;
}

// Collect inline image parts (Content-ID → { mimeType, data?, attachmentId? })
function collectInlineImages(payload: any): { cid: string; mimeType: string; data?: string; attachmentId?: string }[] {
  const results: { cid: string; mimeType: string; data?: string; attachmentId?: string }[] = [];
  if (!payload) return results;

  function walk(parts: any[]) {
    for (const part of parts) {
      if (part.mimeType?.startsWith("image/")) {
        const cidHeader = (part.headers ?? []).find((h: any) => h.name?.toLowerCase() === "content-id");
        if (cidHeader?.value) {
          const cid = cidHeader.value.replace(/^<|>$/g, "");
          results.push({
            cid,
            mimeType: part.mimeType,
            data: part.body?.data ?? undefined,
            attachmentId: part.body?.attachmentId ?? undefined,
          });
        }
      }
      if (part.parts) walk(part.parts);
    }
  }

  if (payload.parts) walk(payload.parts);
  return results;
}

// Replace cid: references in HTML with base64 data URIs
async function inlineCidImages(html: string, payload: any, gmail: any, messageId: string): Promise<string> {
  const images = collectInlineImages(payload);
  if (images.length === 0) return html;

  let result = html;
  for (const img of images) {
    let base64Data = img.data;
    if (!base64Data && img.attachmentId) {
      try {
        const att = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: img.attachmentId,
        });
        base64Data = att.data.data;
      } catch {
        continue;
      }
    }
    if (!base64Data) continue;
    // Gmail API returns base64url — convert to standard base64 for data URI
    const std = base64Data.replace(/-/g, "+").replace(/_/g, "/");
    const dataUri = `data:${img.mimeType};base64,${std}`;
    result = result.replace(new RegExp(`cid:${img.cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), dataUri);
  }
  return result;
}

export function extractBody(payload: any): string {
  if (!payload) return "";

  // Single-part message
  if (payload.body?.data && !payload.parts?.length) {
    const raw = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    // If the top-level part is HTML, strip tags
    if (payload.mimeType === "text/html") return stripHtml(raw);
    // Skip placeholder text if there are no other parts to fall back to
    if (isPlaceholderText(raw)) return "";
    return raw;
  }

  // Multipart — prefer text/plain, fall back to text/html
  const parts: any[] = payload.parts ?? [];
  let textPart: any = null;
  let htmlPart: any = null;

  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      textPart = part;
    } else if (part.mimeType === "text/html" && part.body?.data) {
      htmlPart = part;
    } else if (part.parts) {
      // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
      // Flatten nested parts into our search instead of returning early
      for (const sub of part.parts) {
        if (sub.mimeType === "text/plain" && sub.body?.data && !textPart) {
          textPart = sub;
        } else if (sub.mimeType === "text/html" && sub.body?.data && !htmlPart) {
          htmlPart = sub;
        } else if (sub.parts) {
          const nested = extractBody(sub);
          if (nested) return nested;
        }
      }
    }
  }

  if (textPart?.body?.data) {
    const plain = Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    // Skip useless placeholder text — use HTML part instead
    if (!isPlaceholderText(plain) || !htmlPart?.body?.data) {
      return plain;
    }
  }
  if (htmlPart?.body?.data) {
    const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
    return stripHtml(html);
  }
  return "";
}

async function fetchGmail(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { group_by_thread = false } = config;

  if (group_by_thread) {
    return fetchGmailThreads(config);
  }
  return fetchGmailMessages(config);
}

// Individual messages mode — one item per matching email
async function fetchGmailMessages(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { google } = await import("googleapis");
  const conn = await db.getConnection("gmail");
  if (!conn) throw new Error("Gmail not connected. Please connect Gmail in Settings → Connections.");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  const gmail = google.gmail({ version: "v1", auth });
  const { query = "" } = config;

  const messages: { id: string; threadId?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    if (list.data.messages) {
      messages.push(...(list.data.messages as { id: string; threadId?: string }[]));
    }
    pageToken = list.data.nextPageToken ?? undefined;
    if (pageToken) await delay(200);
  } while (pageToken);

  const results: Record<string, any>[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (i > 0 && i % 10 === 0) await delay(500);
    const msg = messages[i];
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "full",
    });
    const headers = full.data.payload?.headers ?? [];
    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) headerMap[h.name] = h.value;
    }
    const body = extractBody(full.data.payload);
    results.push({
      id: msg.id,
      threadId: msg.threadId,
      from: headerMap.From ?? "",
      to: headerMap.To ?? "",
      subject: headerMap.Subject ?? "",
      date: headerMap.Date ?? "",
      snippet: full.data.snippet ?? "",
      body,
    });
  }

  return results;
}

// Thread-grouped mode — one item per thread with full conversation history
async function fetchGmailThreads(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { google } = await import("googleapis");
  const conn = await db.getConnection("gmail");
  if (!conn) throw new Error("Gmail not connected. Please connect Gmail in Settings → Connections.");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  const gmail = google.gmail({ version: "v1", auth });
  const { query = "" } = config;

  // threads.list natively returns one entry per thread — no dedup needed
  const threadIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.threads.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    for (const t of list.data.threads ?? []) {
      if (t.id) threadIds.push(t.id);
    }
    pageToken = list.data.nextPageToken ?? undefined;
    if (pageToken) await delay(200);
  } while (pageToken);

  const results: Record<string, any>[] = [];

  for (let i = 0; i < threadIds.length; i++) {
    if (i > 0 && i % 5 === 0) await delay(1000); // Rate limit
    const threadId = threadIds[i];

    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const threadMessages = (thread.data.messages ?? []).map((m: any) => {
      const headers = m.payload?.headers ?? [];
      const headerMap: Record<string, string> = {};
      for (const h of headers) {
        if (h.name && h.value) headerMap[h.name] = h.value;
      }
      return {
        id: m.id,
        from: headerMap.From ?? "",
        to: headerMap.To ?? "",
        cc: headerMap.Cc ?? "",
        subject: headerMap.Subject ?? "",
        date: headerMap.Date ?? "",
        snippet: m.snippet ?? "",
        body: extractBody(m.payload),
      };
    });

    const first = threadMessages[0] ?? {};
    const last = threadMessages[threadMessages.length - 1] ?? {};
    results.push({
      id: threadId,
      threadId,
      from: first.from,
      to: first.to,
      subject: first.subject,
      date: first.date,
      snippet: last.snippet,
      body: first.body,
      message_count: threadMessages.length,
      latest_message: last,
      thread_messages: threadMessages,
    });
  }

  return results;
}

// Lightweight Gmail fetch using threads.list — only 1-2 API calls total
// Returns thread-level data (id, snippet) without fetching individual messages
async function fetchGmailMetadata(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { google } = await import("googleapis");
  const conn = await db.getConnection("gmail");
  if (!conn) throw new Error("Gmail not connected.");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  const gmail = google.gmail({ version: "v1", auth });
  const { query = "" } = config;

  const results: Record<string, any>[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.threads.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    for (const thread of list.data.threads ?? []) {
      results.push({
        id: thread.id,
        threadId: thread.id,
        snippet: thread.snippet ?? "",
      });
    }
    pageToken = list.data.nextPageToken ?? undefined;
    if (pageToken) await delay(200);
  } while (pageToken);

  return results;
}

// Fetch all messages in a Gmail thread
export async function fetchGmailThread(threadId: string, slim = false): Promise<Record<string, any>[]> {
  const { google } = await import("googleapis");
  const conn = await db.getConnection("gmail");
  if (!conn) throw new Error("Gmail not connected.");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  const gmail = google.gmail({ version: "v1", auth });
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: slim ? "metadata" : "full",
    ...(slim ? { metadataHeaders: ["From", "To", "Cc", "Bcc", "Subject", "Date"] } : {}),
  });

  const results: Record<string, any>[] = [];
  for (const msg of (thread.data.messages ?? [])) {
    const headers = msg.payload?.headers ?? [];
    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) headerMap[h.name] = h.value;
    }
    if (slim) {
      results.push({
        id: msg.id, threadId: msg.threadId,
        from: headerMap.From ?? "", to: headerMap.To ?? "",
        cc: headerMap.Cc ?? "", bcc: headerMap.Bcc ?? "",
        subject: headerMap.Subject ?? "", date: headerMap.Date ?? "",
        snippet: msg.snippet ?? "",
      });
    } else {
      let bodyHtml = extractHtmlBody(msg.payload);
      if (bodyHtml) {
        bodyHtml = await inlineCidImages(bodyHtml, msg.payload, gmail, msg.id ?? "");
      }
      results.push({
        id: msg.id, threadId: msg.threadId,
        from: headerMap.From ?? "", to: headerMap.To ?? "",
        cc: headerMap.Cc ?? "", bcc: headerMap.Bcc ?? "",
        subject: headerMap.Subject ?? "", date: headerMap.Date ?? "",
        snippet: msg.snippet ?? "",
        body: extractBody(msg.payload),
        body_html: bodyHtml,
      });
    }
  }
  return results;
}

/** Fetch a single Gmail message with full body */
export async function fetchGmailMessage(messageId: string): Promise<Record<string, any>> {
  const { google } = await import("googleapis");
  const conn = await db.getConnection("gmail");
  if (!conn) throw new Error("Gmail not connected.");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  const gmail = google.gmail({ version: "v1", auth });
  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = full.data.payload?.headers ?? [];
  const headerMap: Record<string, string> = {};
  for (const h of headers) {
    if (h.name && h.value) headerMap[h.name] = h.value;
  }
  let bodyHtml = extractHtmlBody(full.data.payload);
  if (bodyHtml) {
    bodyHtml = await inlineCidImages(bodyHtml, full.data.payload, gmail, messageId);
  }
  return {
    id: full.data.id, threadId: full.data.threadId,
    from: headerMap.From ?? "", to: headerMap.To ?? "",
    cc: headerMap.Cc ?? "", bcc: headerMap.Bcc ?? "",
    subject: headerMap.Subject ?? "", date: headerMap.Date ?? "",
    snippet: full.data.snippet ?? "",
    body: extractBody(full.data.payload),
    body_html: bodyHtml,
  };
}

// Lightweight list preview — metadata only for Gmail, full fetch for others
export async function fetchListPreview(
  source: string | null,
  config: Record<string, any>,
): Promise<Record<string, any>[]> {
  if (!source) return [];
  if (source === "gmail") return fetchGmailMetadata(config);
  return fetchList(source, config);
}

// Count-only Gmail — just paginates message IDs, skips fetching bodies
async function countGmail(config: Record<string, any>): Promise<number> {
  const { google } = await import("googleapis");
  const conn = await db.getConnection("gmail");
  if (!conn) throw new Error("Gmail not connected.");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(conn.credentials);
  auth.once("tokens", async (tokens: any) => {
    await db.updateConnection("gmail", { ...conn.credentials, ...tokens });
  });

  const gmail = google.gmail({ version: "v1", auth });
  const { query = "" } = config;

  let count = 0;
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    count += (list.data.messages ?? []).length;
    pageToken = list.data.nextPageToken ?? undefined;
    if (pageToken) await delay(200);
  } while (pageToken);

  return count;
}

async function fetchSlack(config: Record<string, any>): Promise<Record<string, any>[]> {
  const { channel_id } = config;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const allMessages: Record<string, any>[] = [];
  let cursor: string | undefined;

  do {
    const res = await fetch("https://slack.com/api/conversations.history", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channel_id, limit: 200, cursor }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack fetch: ${data.error}`);
    allMessages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor || undefined;
    if (cursor) await delay(500);
  } while (cursor);

  return allMessages;
}

export interface AIListResult {
  items: Record<string, any>[];
  cost_usd: number;
  steps: { type: string; data: string; ts: number }[];
  agentText: string;
}

// Stored result from the last fetchAI call — runner reads this after fetchList
let lastAIListResult: AIListResult | null = null;
export function getLastAIListResult(): AIListResult | null {
  const r = lastAIListResult;
  lastAIListResult = null;
  return r;
}

async function fetchAI(config: Record<string, any>, onStep?: (step: AgentStep) => void): Promise<Record<string, any>[]> {
  const { prompt, model } = config;
  if (!prompt) throw new Error("AI list source requires a prompt");

  const mcpServers = JSON.parse(process.env.MCP_SERVERS ?? "{}");
  const today = new Date().toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  const mcpNames = Object.keys(mcpServers);

  const systemPrompt = `Today is ${today}.

${mcpNames.length > 0 ? `You have access to the following external tools via MCP: ${mcpNames.join(", ")}. Use them to query databases, search emails, and check records. Always use your tools to gather any information you need — never say you cannot access something without trying first.` : ""}

Your job is to generate a list of items based on the user's description. Use your tools to find the relevant data, then return the results as a JSON array.

IMPORTANT: Your final output must end with a JSON array wrapped in \`\`\`json ... \`\`\` fences. Each element should be an object with relevant fields. Every item MUST have a "title" field — a short human-readable label describing that item. Include all data the next agent will need to act on each item (IDs, names, emails, context, etc.).

If you find no matching items, return an empty array: \`\`\`json\n[]\n\`\`\``;

  const { text, steps, cost_usd } = await runAgentHeadless({
    prompt,
    model: model || "claude-opus-4-6",
    mcpServers,
    systemPrompt,
    onStep,
  });

  console.log(`[AI_LIST] Agent returned (cost: $${cost_usd.toFixed(4)})`);

  // Extract JSON array from the agent's response
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    console.error("[AI_LIST] No JSON array found in agent response:", text.slice(0, 500));
    lastAIListResult = { items: [], cost_usd, steps, agentText: text };
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const items = Array.isArray(parsed) ? parsed : [parsed];
    console.log(`[AI_LIST] Parsed ${items.length} item(s)`);
    lastAIListResult = { items, cost_usd, steps, agentText: text };
    return items;
  } catch (err) {
    console.error("[AI_LIST] Failed to parse JSON:", err);
    lastAIListResult = { items: [], cost_usd, steps, agentText: text };
    return [];
  }
}
