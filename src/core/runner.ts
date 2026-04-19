import pLimit from "p-limit";
import * as fs from "fs/promises";
import * as path from "path";
import * as db from "./db.js";
import { fetchList, getLastAIListResult } from "./list-fetchers.js";
import { aiFilter } from "./ai-filter.js";
import { runAgentHeadless } from "./agent.js";
import type { Workflow, ExecutionRun, SkipCondition } from "./types.js";
import { emit } from "./events.js";
import { parseAgentActions, executeAction } from "./actions.js";
import { slackPost, itemLabel, actionGist, summarizeActions, agentSummary, notifyItemExecution } from "./slack-notify.js";

const mcpServers = () => JSON.parse(process.env.MCP_SERVERS ?? "{}");

// Shared memory directory — one brain across all workflows
const MEMORY_ROOT = path.resolve("memory");

function resolveMemoryDir(workflow: Workflow): string {
  if (workflow.memory_dir) return path.resolve(workflow.memory_dir);
  return MEMORY_ROOT;
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_AUTH = process.env.SUPABASE_AUTH_TOKEN || process.env.SUPABASE_ANON_KEY!;

const EMAIL_SEND_ACTIONS = new Set(["reply_email", "send_email", "forward_email"]);

/**
 * Scan all awaiting_approval items for thread_id overlaps with this item's actions.
 * Mutates the actions array to add `_thread_conflict` flags, and also updates
 * the conflicting items in the DB.
 */
async function tagThreadConflicts(itemId: string, actions: any[]): Promise<void> {
  // Collect thread_ids from this item's email-send actions
  const myThreadIds = new Set<string>();
  for (const a of actions) {
    if (EMAIL_SEND_ACTIONS.has(a.action) && a.thread_id) {
      myThreadIds.add(a.thread_id);
    }
  }
  if (myThreadIds.size === 0) return;

  // Fetch all pending approval items
  const pending = await db.listPendingApprovals();

  for (const other of pending) {
    if (other.id === itemId) continue;
    const otherActions = (other.agent_actions ?? []) as any[];
    let otherModified = false;

    for (const oa of otherActions) {
      if (EMAIL_SEND_ACTIONS.has(oa.action) && oa.thread_id && myThreadIds.has(oa.thread_id)) {
        // Tag both sides
        oa._thread_conflict = itemId;
        otherModified = true;

        // Tag our action too
        for (const a of actions) {
          if (EMAIL_SEND_ACTIONS.has(a.action) && a.thread_id === oa.thread_id) {
            a._thread_conflict = other.id;
          }
        }
      }
    }

    if (otherModified) {
      await db.updateItem(other.id, { agent_actions: otherActions });
    }
  }
}

export async function applySkipConditions(
  items: Record<string, any>[],
  raw: SkipCondition | SkipCondition[],
): Promise<Record<string, any>[]> {
  const conditions = Array.isArray(raw) ? raw : [raw];
  for (const condition of conditions) {
    if (items.length === 0) break;
    items = await applySkipCondition(items, condition);
  }
  return items;
}

async function applySkipCondition(
  items: Record<string, any>[],
  condition: SkipCondition,
): Promise<Record<string, any>[]> {
  // "no_external_reply" — skip threads where someone external has replied
  // (keeps threads where only "us" + mailer-daemon/bounce messages exist)
  if (condition.source === "no_external_reply") {
    return await applyNoExternalReplySkip(items);
  }

  if (condition.source === "max_messages") {
    const max = condition.max_messages ?? 4;
    return items.filter((item) => {
      const count = item.message_count ?? (item.thread_messages as any[] | undefined)?.length ?? 0;
      return count <= max;
    });
  }

  if (condition.source === "recent_activity") {
    const minAgeMs = (condition.min_age_minutes ?? 1440) * 60 * 1000;
    const cutoff = Date.now() - minAgeMs;
    return items.filter((item) => {
      const dateStr = item.latest_message?.date ?? item.date;
      if (!dateStr) return true; // no date info, keep it
      const msgTime = new Date(dateStr).getTime();
      return !isNaN(msgTime) && msgTime <= cutoff;
    });
  }

  if (!condition.match?.length) return items;

  let records: Record<string, any>[];

  if (condition.source === "knowledge") {
    const knowledgeRecords = await db.listKnowledge({
      type: condition.knowledge_type,
      limit: 10000,
    });
    records = knowledgeRecords.map((r) => r.data);
  } else {
    // Supabase — fetch matching records via PostgREST
    const selectFields = condition.match.map((m) => m.record_field);
    if (condition.where) {
      for (const field of Object.keys(condition.where)) {
        if (!selectFields.includes(field)) selectFields.push(field);
      }
    }
    const url = new URL(`${SUPABASE_URL}/rest/v1/${condition.table}`);
    url.searchParams.set("select", selectFields.join(","));
    url.searchParams.set("limit", "10000");
    if (condition.where) {
      for (const [field, value] of Object.entries(condition.where)) {
        url.searchParams.set(field, `eq.${value}`);
      }
    }
    const headers: Record<string, string> = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_AUTH}`,
    };
    if (condition.schema) headers["Accept-Profile"] = condition.schema;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Skip condition Supabase fetch: ${res.status} ${await res.text()}`);
    records = await res.json();
  }

  // Build lookup set of record keys
  const recordKeys = new Set<string>();
  for (const r of records) {
    // Check where conditions
    if (condition.where) {
      let matches = true;
      for (const [field, value] of Object.entries(condition.where)) {
        if (String(r[field]) !== value) { matches = false; break; }
      }
      if (!matches) continue;
    }
    const key = condition.match.map((m) => String(r[m.record_field] ?? "")).join("\0");
    recordKeys.add(key);
  }

  // Filter out items that match
  return items.filter((item) => {
    const key = condition.match.map((m) => String(item[m.item_field] ?? "")).join("\0");
    return !recordKeys.has(key);
  });
}

/** Extract email address from a From header like "Name <email@example.com>" or plain "email@example.com" */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

/** Check if an email address is a mailer-daemon / bounce / auto-reply */
function isBounceSender(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    lower.includes("mailer-daemon") ||
    lower.includes("postmaster") ||
    lower.startsWith("noreply") ||
    lower.startsWith("no-reply") ||
    lower.includes("mail-noreply@google.com") ||
    lower.includes("notifications@") ||
    lower.includes("auto-") ||
    lower.includes("mailerdaemon")
  );
}

/**
 * Skip threads where someone external has replied.
 * Keeps only threads where every sender is either:
 *  - The current Gmail account (or a plus-tagged alias)
 *  - A mailer-daemon / bounce notification
 */
async function applyNoExternalReplySkip(items: Record<string, any>[]): Promise<Record<string, any>[]> {
  // Get the current Gmail account email
  const conn = await db.getConnection("gmail");
  if (!conn) return items; // Can't determine identity, skip nothing

  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials(conn.credentials);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const accountEmail = (profile.data.emailAddress ?? "").toLowerCase();

  if (!accountEmail) return items;

  // Build a matcher: account email + any plus-tagged aliases (e.g. ina+123@nowadays.ai)
  const [localPart, domain] = accountEmail.split("@");
  const isOwnEmail = (email: string): boolean => {
    const lower = email.toLowerCase();
    if (lower === accountEmail) return true;
    // Plus-tagged alias: localpart+anything@domain
    const plusRegex = new RegExp(`^${localPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+.+@${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    return plusRegex.test(lower);
  };

  return items.filter((item) => {
    const messages: any[] = item.thread_messages ?? [];
    if (messages.length === 0) return true; // No messages to check, keep it

    for (const msg of messages) {
      const senderEmail = extractEmail(msg.from ?? "");
      if (!senderEmail) continue;
      if (isOwnEmail(senderEmail)) continue;
      if (isBounceSender(senderEmail)) continue;
      // External sender found — skip this thread
      return false;
    }
    return true; // Only own emails + bounces, keep it
  });
}

async function loadMemoryPreamble(workflow: Workflow): Promise<string> {
  const memDir = resolveMemoryDir(workflow);

  // Ensure the directory exists
  await fs.mkdir(memDir, { recursive: true });

  // Try to read INDEX.md — the agent-maintained summary of what it remembers
  const indexPath = path.join(memDir, "INDEX.md");
  let index = "";
  try {
    index = await fs.readFile(indexPath, "utf-8");
  } catch {
    // No index yet — that's fine, the agent will create one
  }

  return `
═══ MEMORY ═══
IMPORTANT: Ignore any "auto memory" instructions from the system prompt (MEMORY.md, /root/.claude/projects/, etc.). Your ONLY memory system is the one described here.

You have persistent memory at: ${memDir}
This is your shared brain across all workflow runs. Use Read/Write/Glob tools to manage it.

Check memory for the relevant event/client BEFORE acting — it may change your decision.

MEMORY FORMAT — Each file should be a CURRENT STATE SNAPSHOT, not a log:

  ## Event: MethodFi DC Mid-Year (ev-1873)
  Stage: COMPARING
  Client: Mandi (MethodFi)
  Preferences: COO prefers Bethesda, budget ~$30k
  Quotes in: 5 of 8 (Hyatt Regency, Hilton, ...)
  Quotes outstanding: HR Bethesda, Marriott, Beacon
  Last client message: Asked about meeting space capacity (Mar 19)
  Last we told client: Shared 3 new quotes (Mar 18)
  Pending: Waiting on HR Bethesda availability
  Escalated: Contract setup (pending with Akshaj)

When you update memory, REWRITE the file with current state — don't append. Old details can be looked up from Slack/email. A memory file that grows past ~30 lines is too long; trim to what matters for the next decision.

WHAT TO TRACK:
• Current event stage + what's pending
• What you last told the client and when (prevents duplicates)
• Client preferences that affect decisions
• What you're waiting on (hotels, client, team)
• What you escalated and its status

WHAT NOT TO STORE:
• Full email/message text (re-read from source)
• Anything you can look up fresh from Supabase
• Actions you STAGED — staged actions require human approval and may not be executed. Only record things you directly observed (emails received, Slack messages seen, database state). Never write to memory as if a staged action already happened.

ORGANIZATION:
  events/ev-XXXX.md     — one file per event with all relevant state (client prefs, hotel status, pending items)
  INDEX.md              — concise directory (file paths + one-line descriptions)

Keep it to one file per event. Don't create separate files for hotels or individual interactions. INDEX.md is loaded into every prompt, so keep it short — just pointers to files.

${index ? `Current INDEX.md:\n${index}` : "Memory is empty — this is your first run. Do extra research before acting (read more Slack history, check more email threads) since you have no prior context. Start building memory as you work."}
═══════════════
`;
}

// Build a preamble telling the agent what MCP tools it has access to
async function toolsPreamble(): Promise<string> {
  const servers = mcpServers();
  const names = Object.keys(servers);

  const today = new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  let preamble = `Today is ${today}.\n\n`;

  if (names.length > 0) {
    preamble += `You have access to the following external tools via MCP: ${names.join(", ")}. Use them to query databases, search emails, and check records. Always use your tools to gather any information you need — never say you cannot access something without trying first.

MCP tool results are returned directly as text — just read them as-is. Do NOT try to parse MCP results with jq, python, node -e, or grep. If the result is JSON, you can read it directly. When querying multiple records, use batch filters (e.g. venue_static_id=in.(id1,id2,id3)) instead of querying one at a time.\n\n`;
  }

  // Knowledge database instructions
  const knowledgeTypes = await db.listKnowledgeTypes();
  if (knowledgeTypes.length > 0) {
    const port = process.env.PORT || 8080;
    const base = `http://localhost:${port}/api/knowledge`;

    let typesList = "";
    for (const kt of knowledgeTypes) {
      const fields = kt.fields.map((f) => {
        let desc = `${f.name} (${f.type}${f.required ? ", required" : ""})`;
        if (f.options?.length) desc += ` [${f.options.join(", ")}]`;
        if (f.description) desc += ` — ${f.description}`;
        return desc;
      }).join("\n      ");
      typesList += `  - ${kt.name}: ${kt.description}\n      ${fields}\n`;
    }

    preamble += `═══ KNOWLEDGE DATABASE ═══
You have access to a structured knowledge database for storing and retrieving business data.
Use Bash with curl to interact with it.

Available types:
${typesList}
QUERY records:
  curl -s '${base}/records?type=TYPE_NAME' | cat
  curl -s '${base}/records?type=TYPE_NAME&search=SEARCH_TERM' | cat
  curl -s '${base}/records?type=TYPE_NAME&format=text'    (for a readable table)

UPSERT a record (update if match exists, create otherwise):
  curl -s -X POST ${base}/records/upsert -H 'Content-Type: application/json' -d '{"type":"TYPE_NAME","match_on":["field1","field2"],"data":{...},"created_by":"workflow:WORKFLOW_NAME"}'

CREATE a new record:
  curl -s -X POST ${base}/records -H 'Content-Type: application/json' -d '{"type":"TYPE_NAME","data":{...},"created_by":"workflow:WORKFLOW_NAME"}'

DELETE a record:
  curl -s -X DELETE ${base}/records/RECORD_ID

Always check knowledge BEFORE acting — query first, then upsert to avoid duplicates.
═══════════════════════════

`;
  }

  return preamble;
}

function actionInstructions(itemId: string): string {
  const port = process.env.PORT || 8080;
  const base = `http://localhost:${port}/api/executions/${itemId}/actions`;

  return `
═══ ACTION STAGING ═══
As you decide on each action, submit it immediately via curl. Do NOT accumulate actions into one big JSON block at the end.

STAGE an action (call once per action):
  curl -s -X POST ${base} -H 'Content-Type: application/json' -d '{ "action": "...", ... }'

EDIT a staged action (replace by index):
  curl -s -X PUT ${base}/INDEX -H 'Content-Type: application/json' -d '{ "action": "...", ... }'

REMOVE a staged action (by index):
  curl -s -X DELETE ${base}/INDEX

VIEW currently staged actions:
  curl -s ${base} | cat

NOTE: If the staging response contains a "warning" field, READ IT CAREFULLY. Fix the issue (edit or remove the action) before proceeding.

Available action types:
- { "action": "send_email", "to": ["email", ...], "subject": "...", "body": "...", "cc?": [...], "bcc?": [...] }
- { "action": "reply_email", "thread_id": "...", "message_id": "...", "body": "...", "to?": ["email (omit to auto-reply to the right recipients)"], "reply_all?": true, "cc?": [...], "bcc?": [...] }
- { "action": "forward_email", "thread_id": "...", "message_id": "...", "to": ["email"], "body": "...", "cc?": [...], "bcc?": [...] }
- { "action": "send_slack", "channel": "channel_id", "text": "...", "thread_ts?": "..." }
- { "action": "archive_email", "thread_id": "...", "thread_subject?": "optional subject for display", "unarchive?": false }
- { "action": "label_email", "thread_id": "...", "label_name": "Label Name", "thread_subject?": "optional subject for display", "remove?": false }
- { "action": "custom", "description": "plain text description" }
- { "action": "knowledge_upsert", "type": "TYPE_NAME", "match_on": ["field1", "field2"], "data": { ... }, "created_by": "workflow:WORKFLOW_NAME" }
- { "action": "none", "reason": "why no action is needed" }

IMPORTANT: Submit each action as a SEPARATE curl call as you go. After staging all actions, write a brief text summary of what you decided and why.

Formatting rules:
- Email body: plain text only. No markdown (**bold**, _italic_, etc.).
- Slack text: use Slack mrkdwn — *bold*, _italic_, \`code\`, bullet lists with "• ".
═══════════════════════
`;
}

// Legacy: still used as fallback when agent outputs JSON instead of using the staging API
const FORMAT_RETRY_PROMPT = `You described actions in your previous response but didn't include the required JSON action block. Please output the actions you described as a JSON array wrapped in \`\`\`json ... \`\`\`. Include all the details (thread_ids, email addresses, channel IDs, message bodies) from your analysis. Do not re-do any research — just format the actions you already decided on.`;

// In-memory abort signals — checked before processing each item
const abortedRuns = new Set<string>();

export function abortRun(runId: string): void {
  abortedRuns.add(runId);
}

export function isRunAborted(runId: string): boolean {
  return abortedRuns.has(runId);
}

async function log(
  runId: string,
  workflowId: string,
  level: "info" | "warn" | "error",
  message: string,
) {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  console.log(`[${prefix}] run=${runId.slice(-6)} ${message}`);
  await db.addRunLog(runId, level, message).catch(() => {});
  emit({ type: "run_log", workflowId, runId, data: { level, message } } as any);
}

export async function testWorkflow(
  workflow: Workflow,
  run: ExecutionRun,
  specificItem?: Record<string, any>,
  count: number = 1,
): Promise<void> {
  let runCost = 0;
  let isTriggerTest = false;

  try {
    let items: Record<string, any>[];

    if (specificItem?._triggerTest) {
      // Trigger-based test — use selected message as trigger data
      isTriggerTest = true;
      const { _triggerTest, ...triggerData } = specificItem;
      await log(run.id, workflow.id, "info", `Test run for "${workflow.name}" — using selected trigger message`);
      items = [triggerData];
    } else if (specificItem) {
      await log(run.id, workflow.id, "info", `Test run for "${workflow.name}" — using selected item`);
      items = [specificItem];
    } else {
      await log(run.id, workflow.id, "info", `Test run for "${workflow.name}" — fetching ${count} random item(s)`);

      if (!workflow.list_source) {
        await log(run.id, workflow.id, "error", "No list source configured");
        await db.updateRun(run.id, { status: "failed", completed_at: new Date().toISOString() });
        return;
      }

      items = await fetchList(workflow.list_source, workflow.list_config, (step) => {
                if (step.type === "tool_call") {
                  log(run.id, workflow.id, "info", `[list] ${step.data}`);
                } else if (step.type === "thinking") {
                  log(run.id, workflow.id, "info", `[list] 💭 ${step.data}`);
                } else if (step.type === "text") {
                  log(run.id, workflow.id, "info", `[list] 💬 ${step.data}`);
                }
              });
      await log(run.id, workflow.id, "info", `Fetched ${items.length} item(s), picking ${count} at random`);

      if (workflow.ai_filter_prompt && items.length > 0) {
        const filterResult = await aiFilter(items, workflow.ai_filter_prompt);
        items = filterResult.items;
        runCost += filterResult.cost_usd;
        await log(run.id, workflow.id, "info", `AI filter: ${items.length} item(s) remain ($${filterResult.cost_usd.toFixed(4)})`);
      }

      if (workflow.skip_condition && items.length > 0) {
        const beforeCount = items.length;
        items = await applySkipConditions(items, workflow.skip_condition!);
        await log(run.id, workflow.id, "info", `Skip condition: ${beforeCount} → ${items.length} item(s) (${beforeCount - items.length} skipped)`);
      }

      if (items.length === 0) {
        await log(run.id, workflow.id, "info", "No items after filter — nothing to test");
        await db.updateRun(run.id, { status: "completed", cost_usd: runCost, completed_at: new Date().toISOString() });
        return;
      }

      // Pick N distinct random items
      const picked: Record<string, any>[] = [];
      const pool = [...items];
      const n = Math.min(count, pool.length);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
      }
      items = picked;
    }

    await db.updateRun(run.id, { items_total: items.length });

    // Process each test item
    const limit = pLimit(1);
    let completed = 0;

    const itemRows = await Promise.all(
      items.map((item) => db.createItem(run.id, item))
    );

    await Promise.all(
      itemRows.map((itemRow, i) =>
        limit(async () => {
          await db.updateItem(itemRow.id, { status: "running", agent_actions: [] });

          try {
            const itemContext = JSON.stringify(items[i], null, 2);
            const testPreamble = isTriggerTest
              ? (() => {
                  const ts = items[i]?.ts;
                  const timeStr = ts ? new Date(parseFloat(ts) * 1000).toLocaleString() : "unknown";
                  return `IMPORTANT: This is a test on a historical message. Ignore everything that happened after ${timeStr} — treat this message as if it just arrived.\n\n`;
                })()
              : "";
            const triggerCtx = isTriggerTest
              ? `Trigger context:\n${itemContext}\n\n`
              : `Context item:\n${itemContext}\n\n`;
            const memoryPreamble = await loadMemoryPreamble(workflow);
            const prompt = `${await toolsPreamble()}${memoryPreamble}${testPreamble}${triggerCtx}Task: ${workflow.action_prompt}\n\n${actionInstructions(itemRow.id)}`;

            await log(run.id, workflow.id, "info", `Calling agent on test item ${i + 1}/${items.length}...`);
            const { text: result, steps, cost_usd: agentCost, sessionId: agentSessionId } = await runAgentHeadless({
              prompt,
              mcpServers: mcpServers(),
              model: workflow.action_model ?? "claude-opus-4-6",
              effort: workflow.action_effort ?? "high",
              onStep: (step) => {
                if (step.type === "tool_call") {
                  log(run.id, workflow.id, "info", `[item ${i + 1}] ${step.data}`);
                } else if (step.type === "thinking") {
                  log(run.id, workflow.id, "info", `[item ${i + 1}] 💭 ${step.data}`);
                } else if (step.type === "text") {
                  log(run.id, workflow.id, "info", `[item ${i + 1}] 💬 ${step.data}`);
                }
              },
            });

            runCost += agentCost;

            // Read staged actions from DB (submitted by agent via curl during execution)
            const updatedItem = await db.getItem(itemRow.id);
            let finalActions = (updatedItem?.agent_actions ?? []);

            // Fallback: if no actions were staged via API, try parsing from text output
            if (finalActions.length === 0) {
              const parsed = parseAgentActions(result ?? "");
              if (parsed.actions.length > 0) {
                finalActions = parsed.actions;
              } else if (result && result.length > 100 && agentSessionId) {
                // Last resort: format retry
                await log(run.id, workflow.id, "warn", `Test item ${i + 1}: no staged actions — trying format retry`);
                const { text: retryResult, cost_usd: retryCost } = await runAgentHeadless({
                  prompt: FORMAT_RETRY_PROMPT,
                  sessionId: agentSessionId,
                  model: workflow.action_model ?? "claude-opus-4-6",
                  effort: "low",
                  maxTurns: 2,
                });
                runCost += retryCost;
                const retryParsed = parseAgentActions(retryResult ?? "");
                if (retryParsed.actions.length > 0) {
                  finalActions = retryParsed.actions;
                  await log(run.id, workflow.id, "info", `Test item ${i + 1}: format retry got ${retryParsed.actions.length} action(s)`);
                }
              }
            }

            await log(run.id, workflow.id, "info", `Test item ${i + 1}: ${finalActions.length} action(s) staged for approval ($${agentCost.toFixed(4)})`);
            await db.updateItem(itemRow.id, {
              status: "awaiting_approval",
              agent_result: result,
              agent_actions: finalActions,
              agent_steps: steps,
              cost_usd: agentCost,
              completed_at: new Date().toISOString(),
            });
          } catch (err) {
            await log(run.id, workflow.id, "error", `Test item ${i + 1} failed: ${err}`);
            await db.updateItem(itemRow.id, {
              status: "failed",
              agent_result: String(err),
              completed_at: new Date().toISOString(),
            });
          }

          completed++;
          await db.updateRun(run.id, { items_completed: completed, cost_usd: runCost });
        })
      )
    );

    await db.updateRun(run.id, {
      status: "completed",
      cost_usd: runCost,
      completed_at: new Date().toISOString(),
    });
    await log(run.id, workflow.id, "info", `Test complete — ${completed}/${items.length} items, $${runCost.toFixed(4)}`);
    emit({ type: "run_completed", workflowId: workflow.id, workflowName: workflow.name, runId: run.id });
  } catch (err) {
    await log(run.id, workflow.id, "error", `Test failed: ${err}`).catch(() => {});
    await db.updateRun(run.id, { status: "failed", cost_usd: runCost, completed_at: new Date().toISOString() });
  }
}

export async function runWorkflow(
  workflow: Workflow,
  run: ExecutionRun,
  triggerData?: Record<string, any>,
  limit?: number,
): Promise<void> {
  let runCost = 0;

  try {
    await log(run.id, workflow.id, "info", `Workflow "${workflow.name}" started (trigger: ${run.triggered_by})`);

    // Step 1: Fetch list
    let items: Record<string, any>[];
    if (workflow.list_source) {
      await log(run.id, workflow.id, "info", `Fetching list from ${workflow.list_source}...`);
      items = await fetchList(workflow.list_source, workflow.list_config, (step) => {
                if (step.type === "tool_call") {
                  log(run.id, workflow.id, "info", `[list] ${step.data}`);
                } else if (step.type === "thinking") {
                  log(run.id, workflow.id, "info", `[list] 💭 ${step.data}`);
                } else if (step.type === "text") {
                  log(run.id, workflow.id, "info", `[list] 💬 ${step.data}`);
                }
              });
      await log(run.id, workflow.id, "info", `Fetched ${items.length} item(s) from ${workflow.list_source}`);

      // Log AI list agent trace if applicable
      if (workflow.list_source === "ai") {
        const aiResult = getLastAIListResult();
        if (aiResult) {
          runCost += aiResult.cost_usd;
          await log(run.id, workflow.id, "info", `AI list agent cost: $${aiResult.cost_usd.toFixed(4)} (${aiResult.steps.length} steps)`);
          // Store the agent trace in run logs for visibility
          for (const step of aiResult.steps) {
            if (step.type === "tool_call") {
              await log(run.id, workflow.id, "info", `[list-agent] ${step.data}`);
            }
          }
          // Log the agent's reasoning/summary (text before the JSON block)
          const summary = aiResult.agentText.split("```json")[0].trim();
          if (summary) {
            await log(run.id, workflow.id, "info", `[list-agent] ${summary.slice(0, 500)}`);
          }
        }
      }
    } else if (triggerData) {
      items = [triggerData];
      await log(run.id, workflow.id, "info", "Using trigger data as input (1 item)");
    } else {
      items = [{ trigger: workflow.trigger_type }];
    }

    // Step 2: Optional AI filter
    if (workflow.ai_filter_prompt && items.length > 0) {
      const beforeCount = items.length;
      await log(run.id, workflow.id, "info", `Running AI filter on ${beforeCount} item(s)...`);
      const filterResult = await aiFilter(items, workflow.ai_filter_prompt);
      items = filterResult.items;
      runCost += filterResult.cost_usd;
      await log(run.id, workflow.id, "info", `AI filter: ${beforeCount} → ${items.length} item(s) ($${filterResult.cost_usd.toFixed(4)})`);
    }

    // Step 2b: Skip condition — filter out items already handled (zero AI cost)
    if (workflow.skip_condition && items.length > 0) {
      const beforeCount = items.length;
      items = await applySkipConditions(items, workflow.skip_condition!);
      await log(run.id, workflow.id, "info", `Skip condition: ${beforeCount} → ${items.length} item(s) (${beforeCount - items.length} skipped)`);
    }

    // Apply limit if specified
    if (limit && limit > 0 && items.length > limit) {
      await log(run.id, workflow.id, "info", `Limiting to first ${limit} of ${items.length} item(s)`);
      items = items.slice(0, limit);
    }

    // Update run with total count
    await db.updateRun(run.id, { items_total: items.length });
    emit({ type: "run_started", workflowId: workflow.id, workflowName: workflow.name, runId: run.id });

    if (items.length === 0) {
      await log(run.id, workflow.id, "info", "No items to process — run complete");
      await db.updateRun(run.id, {
        status: "completed",
        cost_usd: runCost,
        completed_at: new Date().toISOString(),
      });
      return;
    }

    // Create item rows
    const itemRows = await Promise.all(
      items.map((item) => db.createItem(run.id, item))
    );

    // Step 3: Process each item
    const concurrency = pLimit(1);
    let completed = 0;

    await Promise.all(
      itemRows.map((itemRow, i) =>
        concurrency(async () => {
          // Check abort before starting each item
          if (isRunAborted(run.id)) {
            await db.updateItem(itemRow.id, { status: "failed", agent_result: "Run aborted", completed_at: new Date().toISOString() });
            return;
          }

          await db.updateItem(itemRow.id, { status: "running", agent_actions: [] });

          try {
            await log(run.id, workflow.id, "info", `Processing item ${i + 1}/${items.length}...`);
            const itemContext = JSON.stringify(items[i], null, 2);

            const triggerCtx = triggerData
              ? `\nTrigger context:\n${JSON.stringify(triggerData, null, 2)}\n`
              : "";

            const memoryPreamble = await loadMemoryPreamble(workflow);
            const prompt = `${await toolsPreamble()}${memoryPreamble}${triggerCtx}\nContext item:\n${itemContext}\n\nTask: ${workflow.action_prompt}\n\n${actionInstructions(itemRow.id)}`;

            await log(run.id, workflow.id, "info", `Item ${i + 1}: calling agent...`);
            const { text: result, steps, cost_usd: agentCost, sessionId: agentSessionId } = await runAgentHeadless({
              prompt,
              mcpServers: mcpServers(),
              model: workflow.action_model ?? "claude-opus-4-6",
              effort: workflow.action_effort ?? "high",
              onStep: (step) => {
                if (step.type === "tool_call") {
                  log(run.id, workflow.id, "info", `[item ${i + 1}] ${step.data}`);
                } else if (step.type === "thinking") {
                  log(run.id, workflow.id, "info", `[item ${i + 1}] 💭 ${step.data}`);
                } else if (step.type === "text") {
                  log(run.id, workflow.id, "info", `[item ${i + 1}] 💬 ${step.data}`);
                }
              },
            });

            runCost += agentCost;

            // Read staged actions from DB (submitted by agent via curl during execution)
            const updatedItem = await db.getItem(itemRow.id);
            let finalActions = (updatedItem?.agent_actions ?? []);

            // Fallback: if no actions were staged via API, try parsing from text output
            if (finalActions.length === 0) {
              const parsed = parseAgentActions(result ?? "");
              if (parsed.actions.length > 0) {
                finalActions = parsed.actions;
              } else if (result && result.length > 100 && agentSessionId) {
                await log(run.id, workflow.id, "warn", `Item ${i + 1}: no staged actions — trying format retry`);
                const { text: retryResult, cost_usd: retryCost } = await runAgentHeadless({
                  prompt: FORMAT_RETRY_PROMPT,
                  sessionId: agentSessionId,
                  model: workflow.action_model ?? "claude-opus-4-6",
                  effort: "low",
                  maxTurns: 2,
                });
                runCost += retryCost;
                const retryParsed = parseAgentActions(retryResult ?? "");
                if (retryParsed.actions.length > 0) {
                  finalActions = retryParsed.actions;
                  await log(run.id, workflow.id, "info", `Item ${i + 1}: format retry got ${retryParsed.actions.length} action(s)`);
                }
              }
            }

            const summary = result ?? "";

            if (workflow.action_mode === "staged") {
              const actionTypes = finalActions.map((a: any) => a.action).join(", ") || "none";
              await log(run.id, workflow.id, "info", `Item ${i + 1}: ${finalActions.length} action(s) staged for approval [${actionTypes}] ($${agentCost.toFixed(4)})`);

              // Tag thread conflicts across all pending approvals
              await tagThreadConflicts(itemRow.id, finalActions);

              await db.updateItem(itemRow.id, {
                status: "awaiting_approval",
                agent_result: result,
                agent_actions: finalActions,
                agent_steps: steps,
                cost_usd: agentCost,
                completed_at: new Date().toISOString(),
              });
              emit({
                type: "item_staged",
                workflowId: workflow.id,
                workflowName: workflow.name,
                runId: run.id,
                itemId: itemRow.id,
                data: { result: summary.slice(0, 200) },
              });
            } else {
              // Auto mode — split actions if auto_execute_actions filter is set
              const allowedAuto = workflow.auto_execute_actions;
              const autoActions = allowedAuto
                ? finalActions.filter((a: any) => allowedAuto.includes(a.action))
                : finalActions;
              const stagedActions = allowedAuto
                ? finalActions.filter((a: any) => !allowedAuto.includes(a.action))
                : [];

              // Execute allowed actions
              if (autoActions.length > 0) {
                await log(run.id, workflow.id, "info", `Item ${i + 1}: auto-executing ${autoActions.length} action(s)...`);
              }
              const results: string[] = [];
              for (const action of autoActions) {
                try {
                  const r = await executeAction(action as any);
                  results.push(r);
                } catch (err) {
                  results.push(`Failed: ${err}`);
                  await log(run.id, workflow.id, "warn", `Item ${i + 1}: action "${action.action}" failed: ${err}`);
                }
              }

              if (stagedActions.length > 0) {
                await log(run.id, workflow.id, "info", `Item ${i + 1}: ${autoActions.length} auto-executed, ${stagedActions.length} staged for approval ($${agentCost.toFixed(4)})`);
                const fullResult = summary + (results.length > 0 ? "\n\nAuto-executed results:\n" + results.join("\n") : "");
                await db.updateItem(itemRow.id, {
                  status: "awaiting_approval",
                  agent_result: fullResult,
                  agent_actions: stagedActions,
                  agent_steps: steps,
                  cost_usd: agentCost,
                  completed_at: new Date().toISOString(),
                });
                emit({
                  type: "item_staged",
                  workflowId: workflow.id,
                  workflowName: workflow.name,
                  runId: run.id,
                  itemId: itemRow.id,
                  data: { result: summary.slice(0, 200) },
                });
              } else {
                await log(run.id, workflow.id, "info", `Item ${i + 1}: completed ($${agentCost.toFixed(4)})`);
                const fullResult = summary + (results.length > 0 ? "\n\nExecution results:\n" + results.join("\n") : "");
                await db.updateItem(itemRow.id, {
                  status: "completed",
                  agent_result: fullResult,
                  agent_actions: finalActions,
                  agent_steps: steps,
                  cost_usd: agentCost,
                  completed_at: new Date().toISOString(),
                });
                emit({
                  type: "item_completed",
                  workflowId: workflow.id,
                  workflowName: workflow.name,
                  runId: run.id,
                  itemId: itemRow.id,
                  data: { result: fullResult.slice(0, 200) },
                });

                // Notify Slack per-item (auto-executed)
                if (workflow.slack_action_channel) {
                  const updatedForNotify = await db.getItem(itemRow.id);
                  if (updatedForNotify) {
                    notifyItemExecution(workflow.slack_action_channel, updatedForNotify, {
                      autoExecuted: true,
                      workflowName: workflow.name,
                    }).catch((err) => console.error("Slack notify error:", err));
                  }
                }
              }
            }
          } catch (err) {
            await log(run.id, workflow.id, "error", `Item ${i + 1} failed: ${err}`);
            await db.updateItem(itemRow.id, {
              status: "failed",
              agent_result: String(err),
              completed_at: new Date().toISOString(),
            });
            emit({
              type: "item_failed",
              workflowId: workflow.id,
              workflowName: workflow.name,
              runId: run.id,
              itemId: itemRow.id,
            });
          }

          completed++;
          await db.updateRun(run.id, { items_completed: completed, cost_usd: runCost });
        })
      )
    );

    // Clean up abort signal
    const wasAborted = isRunAborted(run.id);
    abortedRuns.delete(run.id);

    if (wasAborted) {
      await log(run.id, workflow.id, "warn", `Workflow "${workflow.name}" aborted — ${completed}/${items.length} items processed, $${runCost.toFixed(4)}`);
      await db.updateRun(run.id, {
        status: "aborted",
        cost_usd: runCost,
        completed_at: new Date().toISOString(),
      });
      emit({ type: "run_completed", workflowId: workflow.id, workflowName: workflow.name, runId: run.id });
      return;
    }

    // Notify Slack channel if configured
    if (workflow.slack_notify_channel) {
      await notifySlack(workflow, run, items.length, completed, runCost);
    }

    await log(run.id, workflow.id, "info", `Workflow "${workflow.name}" completed — ${completed}/${items.length} items, $${runCost.toFixed(4)}`);
    await db.updateRun(run.id, {
      status: "completed",
      cost_usd: runCost,
      completed_at: new Date().toISOString(),
    });
    emit({ type: "run_completed", workflowId: workflow.id, workflowName: workflow.name, runId: run.id });
  } catch (err) {
    await log(run.id, workflow.id, "error", `Workflow failed: ${err}`).catch(() => {});
    await db.updateRun(run.id, {
      status: "failed",
      cost_usd: runCost,
      completed_at: new Date().toISOString(),
    });
  }
}

// Helper functions (summarizeActions, itemLabel, slackPost, agentSummary, actionGist)
// are imported from ./slack-notify.ts

async function notifySlack(
  workflow: Workflow,
  run: ExecutionRun,
  total: number,
  completed: number,
  _costUsd: number,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !workflow.slack_notify_channel) return;
  const channel = workflow.slack_notify_channel;

  const showDetail = total === 1 || workflow.slack_notify_detail;

  // If detail mode is off, send a simple summary message
  if (!showDetail) {
    const modeLabel = workflow.action_mode === "staged" ? "staged for approval" : "auto-executed";
    const header = workflow.slack_notify_header
      ? `*${workflow.slack_notify_header}*`
      : `:white_check_mark: *Workflow "${workflow.name}"* completed`;
    await slackPost(token, channel, `${header}\n${completed}/${total} items ${modeLabel}`);
    return;
  }

  // Detail mode — fetch items and build per-item messages
  const items = await db.listItems(run.id);

  // Check if all no-action — optionally skip notification
  if (workflow.slack_notify_skip_noaction) {
    let allNoAction = true;
    for (const item of items) {
      const actions = item.agent_actions ?? [];
      if (actions.length > 0 && !actions.every((a: any) => a.action === "none")) {
        allNoAction = false;
        break;
      }
    }
    if (allNoAction) return;
  }

  // 1. Summary header message
  const now = new Date().toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const modeLabel = workflow.action_mode === "staged" ? "staged for approval" : "auto-executed";
  const header = workflow.slack_notify_header
    ? `*${workflow.slack_notify_header}*`
    : `:white_check_mark: *Workflow "${workflow.name}"* completed`;
  await slackPost(token, channel, `${header}\n${now} · ${completed}/${total} items ${modeLabel}`);

  // 2. One top-level message per item with thread details
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let idx = 0; idx < items.length; idx++) {
    if (idx > 0) await pause(1000);
    await notifyItemExecution(channel, items[idx], {
      autoExecuted: workflow.action_mode !== "staged",
      workflowName: workflow.name,
    });
  }
}
