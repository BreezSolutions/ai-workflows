import { MongoClient, ObjectId, type Db, type Collection } from "mongodb";
import type { Workflow, WorkflowCreate, WorkflowUpdate, ExecutionRun, ExecutionItem, KnowledgeType, KnowledgeRecord, KnowledgeAttachment } from "./types.js";

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://localhost:27017";
// Automation-owned db: workflows, execution_runs, execution_items, thread_sessions, sessions
const DB_NAME = process.env.MONGO_DB || process.env.MONGODB_DB_NAME || "prod-ai-automation";
// Shared db with the core app: users, connections, settings live there so auth/OAuth
// and global config are unified across both apps.
const SHARED_DB_NAME = process.env.MONGO_SHARED_DB || "prod-ai-bot";

const SHARED_COLLECTIONS = new Set(["users", "connections", "settings"]);

let client: MongoClient;
let db: Db;
let sharedDb: Db;

export async function connectDB(): Promise<void> {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  sharedDb = client.db(SHARED_DB_NAME);
  console.log(`Connected to MongoDB: ${DB_NAME} (+ shared: ${SHARED_DB_NAME})`);
}

function col<T extends { id: string }>(name: string): Collection {
  return (SHARED_COLLECTIONS.has(name) ? sharedDb : db).collection(name);
}

function toDoc(obj: Record<string, any>): Record<string, any> {
  const { id, ...rest } = obj;
  return rest;
}

function fromDoc(doc: any): any {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

// ── Users ────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  created_at: string;
}

export async function findOrCreateUser(email: string, name: string, picture?: string): Promise<User> {
  const existing = await col("users").findOne({ email });
  if (existing) return fromDoc(existing);
  const now = new Date().toISOString();
  const doc = { email, name, picture: picture ?? null, created_at: now };
  const result = await col("users").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as User;
}

export async function getUser(id: string): Promise<User | null> {
  try {
    return fromDoc(await col("users").findOne({ _id: new ObjectId(id) }));
  } catch { return null; }
}

/** On first login, assign all unowned data to this user */
export async function claimUnownedData(userId: string): Promise<number> {
  let claimed = 0;
  for (const collection of ["conversations", "structure_entries", "chats", "workflows", "knowledge_records", "briefing_runs"]) {
    const result = await col(collection).updateMany(
      { user_id: { $exists: false } },
      { $set: { user_id: userId } },
    );
    claimed += result.modifiedCount;
  }
  // Also claim connections (currently global, no user_id)
  const connResult = await col("connections").updateMany(
    { user_id: { $exists: false } },
    { $set: { user_id: userId } },
  );
  claimed += connResult.modifiedCount;
  return claimed;
}

// --- Workflows ---

export async function listWorkflows(): Promise<Workflow[]> {
  const docs = await col("workflows").find().sort({ created_at: -1 }).toArray();
  return docs.map(fromDoc);
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  try {
    const doc = await col("workflows").findOne({ _id: new ObjectId(id) });
    return fromDoc(doc);
  } catch {
    return null;
  }
}

export async function getEnabledWorkflows(): Promise<Workflow[]> {
  const docs = await col("workflows").find({ enabled: true }).toArray();
  return docs.map(fromDoc);
}

export async function getWorkflowsByTrigger(triggerType: string): Promise<Workflow[]> {
  const docs = await col("workflows").find({ enabled: true, trigger_type: triggerType }).toArray();
  return docs.map(fromDoc);
}

export async function createWorkflow(data: WorkflowCreate): Promise<Workflow> {
  const now = new Date().toISOString();
  const doc = { ...data, created_at: now, updated_at: now };
  const result = await col("workflows").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as Workflow;
}

export async function updateWorkflow(id: string, data: WorkflowUpdate): Promise<Workflow> {
  const update = { ...data, updated_at: new Date().toISOString() };
  await col("workflows").updateOne({ _id: new ObjectId(id) }, { $set: update });
  return (await getWorkflow(id))!;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await col("workflows").deleteOne({ _id: new ObjectId(id) });
  await col("execution_runs").deleteMany({ workflow_id: id });
}

// --- Execution Runs ---

export async function createRun(workflowId: string, triggeredBy: string): Promise<ExecutionRun> {
  const doc = {
    workflow_id: workflowId,
    triggered_by: triggeredBy,
    status: "running" as const,
    items_total: 0,
    items_completed: 0,
    cost_usd: 0,
    logs: [],
    started_at: new Date().toISOString(),
    completed_at: null,
  };
  const result = await col("execution_runs").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc };
}

export async function addRunLog(
  runId: string,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  const entry = { ts: new Date().toISOString(), level, message };
  await col("execution_runs").updateOne(
    { _id: new ObjectId(runId) },
    { $push: { logs: entry } as any },
  );
}

export async function updateRun(
  id: string,
  data: Partial<Pick<ExecutionRun, "status" | "items_total" | "items_completed" | "cost_usd" | "completed_at">>
): Promise<ExecutionRun> {
  await col("execution_runs").updateOne({ _id: new ObjectId(id) }, { $set: data });
  const doc = await col("execution_runs").findOne({ _id: new ObjectId(id) });
  return fromDoc(doc);
}

export async function getRun(id: string): Promise<ExecutionRun | null> {
  try {
    const doc = await col("execution_runs").findOne({ _id: new ObjectId(id) });
    return doc ? fromDoc(doc) : null;
  } catch {
    return null;
  }
}

export async function listRuns(workflowId?: string): Promise<ExecutionRun[]> {
  const filter: Record<string, any> = {};
  if (workflowId) filter.workflow_id = workflowId;
  const docs = await col("execution_runs").find(filter).sort({ started_at: -1 }).limit(50).toArray();
  return docs.map(fromDoc);
}

// --- Execution Items ---

export async function createItem(
  runId: string,
  itemData: Record<string, any>
): Promise<ExecutionItem> {
  const doc = {
    run_id: runId,
    item_data: itemData,
    status: "pending" as const,
    agent_result: null,
    cost_usd: 0,
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  const result = await col("execution_items").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc };
}

export async function updateItem(
  id: string,
  data: Partial<Pick<ExecutionItem, "status" | "agent_result" | "agent_actions" | "agent_steps" | "cost_usd" | "completed_at" | "slack_notify_ts" | "slack_notify_channel">>
): Promise<ExecutionItem> {
  await col("execution_items").updateOne({ _id: new ObjectId(id) }, { $set: data });
  const doc = await col("execution_items").findOne({ _id: new ObjectId(id) });
  return fromDoc(doc);
}

export async function getItem(id: string): Promise<ExecutionItem | null> {
  try {
    const doc = await col("execution_items").findOne({ _id: new ObjectId(id) });
    return fromDoc(doc);
  } catch {
    return null;
  }
}

/** Atomically claim an item for approval — returns the item only if it was still awaiting_approval. */
export async function claimItemForApproval(id: string): Promise<ExecutionItem | null> {
  try {
    const result = await col("execution_items").findOneAndUpdate(
      { _id: new ObjectId(id), status: "awaiting_approval" },
      { $set: { status: "approved" } },
      { returnDocument: "after" },
    );
    return result ? fromDoc(result) : null;
  } catch {
    return null;
  }
}

export async function pushItemAction(
  itemId: string,
  action: Record<string, any>
): Promise<number> {
  const result = await col("execution_items").findOneAndUpdate(
    { _id: new ObjectId(itemId) },
    { $push: { agent_actions: action } as any },
    { returnDocument: "after" }
  );
  return ((result as any)?.agent_actions?.length ?? 0);
}

export async function removeItemAction(
  itemId: string,
  index: number
): Promise<number> {
  const doc = await col("execution_items").findOne({ _id: new ObjectId(itemId) });
  if (!doc) return 0;
  const actions: any[] = doc.agent_actions ?? [];
  if (index < 0 || index >= actions.length) return actions.length;
  actions.splice(index, 1);
  await col("execution_items").updateOne(
    { _id: new ObjectId(itemId) },
    { $set: { agent_actions: actions } }
  );
  return actions.length;
}

export async function listItems(runId: string): Promise<ExecutionItem[]> {
  const docs = await col("execution_items").find({ run_id: runId }).sort({ created_at: 1 }).toArray();
  return docs.map(fromDoc);
}

export async function listPendingApprovals(workflowId?: string): Promise<(ExecutionItem & { workflow_name?: string })[]> {
  let filter: Record<string, any> = { status: "awaiting_approval" };
  if (workflowId) {
    const runIds = await col("execution_runs")
      .find({ workflow_id: workflowId })
      .project({ _id: 1 })
      .toArray();
    filter.run_id = { $in: runIds.map((r) => r._id.toString()) };
  }
  const docs = await col("execution_items")
    .find(filter)
    .sort({ created_at: -1 })
    .toArray();
  return docs.map(fromDoc);
}

export async function listCompletedItems(workflowId?: string): Promise<ExecutionItem[]> {
  let filter: Record<string, any> = { status: { $in: ["completed", "approved"] } };
  if (workflowId) {
    const runIds = await col("execution_runs")
      .find({ workflow_id: workflowId })
      .project({ _id: 1 })
      .toArray();
    filter.run_id = { $in: runIds.map((r) => r._id.toString()) };
  }
  const docs = await col("execution_items")
    .find(filter)
    .sort({ completed_at: -1 })
    .toArray();
  return docs.map(fromDoc);
}

export async function clearPendingApprovals(workflowId?: string): Promise<number> {
  let filter: Record<string, any> = { status: "awaiting_approval" };
  if (workflowId) {
    const runIds = await col("execution_runs")
      .find({ workflow_id: workflowId })
      .project({ _id: 1 })
      .toArray();
    filter.run_id = { $in: runIds.map((r) => r._id.toString()) };
  }
  const result = await col("execution_items").deleteMany(filter);
  return result.deletedCount;
}

// Mark any "running" runs as failed (e.g. after process crash)
export async function cleanupStaleRuns(): Promise<number> {
  const result = await col("execution_runs").updateMany(
    { status: "running" },
    { $set: { status: "failed", completed_at: new Date().toISOString() } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[DB] Cleaned up ${result.modifiedCount} stale running run(s)`);
    // Also fail any orphaned running/pending items
    await col("execution_items").updateMany(
      { status: { $in: ["running", "pending"] } },
      { $set: { status: "failed", agent_result: "Process crashed", completed_at: new Date().toISOString() } }
    );
  }
  return result.modifiedCount;
}

// ---- Connections (OAuth tokens, per-user) ----

export interface Connection {
  id: string;
  user_id?: string;
  service: string;        // "gmail" | "slack" | "supabase" | etc.
  email?: string;         // display label (e.g. user's email)
  credentials: Record<string, any>;
  connected_at: string;
}

export async function getConnection(service: string, userId?: string): Promise<Connection | null> {
  const filter: Record<string, any> = { service };
  if (userId) filter.user_id = userId;
  const doc = await col("connections").findOne(filter);
  return doc ? fromDoc(doc) : null;
}

export async function upsertConnection(service: string, data: Omit<Connection, "id" | "connected_at">): Promise<Connection> {
  const now = new Date().toISOString();
  const filter: Record<string, any> = { service };
  if (data.user_id) filter.user_id = data.user_id;
  await col("connections").updateOne(
    filter,
    { $set: { ...data, connected_at: now } },
    { upsert: true }
  );
  return (await getConnection(service, data.user_id))!;
}

export async function updateConnection(service: string, credentials: Record<string, any>, userId?: string): Promise<void> {
  const filter: Record<string, any> = { service };
  if (userId) filter.user_id = userId;
  await col("connections").updateOne(filter, { $set: { credentials } });
}

export async function deleteConnection(service: string, userId?: string): Promise<void> {
  const filter: Record<string, any> = { service };
  if (userId) filter.user_id = userId;
  await col("connections").deleteOne(filter);
}

export async function listConnections(userId?: string): Promise<Connection[]> {
  const filter: Record<string, any> = {};
  if (userId) filter.user_id = userId;
  const docs = await col("connections").find(filter).toArray();
  return docs.map(fromDoc);
}

// ---- Settings ----

export async function getSetting(key: string): Promise<string | null> {
  const doc = await col("settings").findOne({ key });
  return doc?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await col("settings").updateOne(
    { key },
    { $set: { value, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
}

// ── Company-Wide Context ─────────────────────────────────────────────

export interface CompanyContext {
  notes: string;
  files: { name: string; s3_key: string; parsed_text?: string; description?: string }[];
}

export async function getCompanyContext(): Promise<CompanyContext> {
  const doc = await col("settings").findOne({ key: "company_context" });
  return doc?.value ? JSON.parse(doc.value) : { notes: "", files: [] };
}

export async function setCompanyContext(ctx: CompanyContext): Promise<void> {
  await col("settings").updateOne(
    { key: "company_context" },
    { $set: { value: JSON.stringify(ctx), updated_at: new Date().toISOString() } },
    { upsert: true }
  );
}

// ---- Slack Thread Sessions ----

export async function getThreadSession(threadTs: string): Promise<string | null> {
  const doc = await col("thread_sessions").findOne({ thread_ts: threadTs });
  return doc?.session_id ?? null;
}

export async function setThreadSession(threadTs: string, sessionId: string): Promise<void> {
  await col("thread_sessions").updateOne(
    { thread_ts: threadTs },
    { $set: { session_id: sessionId, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
}

// ---- Knowledge Types ----

export async function listKnowledgeTypes(): Promise<KnowledgeType[]> {
  const docs = await col("knowledge_types").find().sort({ label: 1 }).toArray();
  return docs.map(fromDoc);
}

export async function getKnowledgeType(id: string): Promise<KnowledgeType | null> {
  try {
    const doc = await col("knowledge_types").findOne({ _id: new ObjectId(id) });
    return fromDoc(doc);
  } catch { return null; }
}

export async function getKnowledgeTypeByName(name: string): Promise<KnowledgeType | null> {
  const doc = await col("knowledge_types").findOne({ name });
  return fromDoc(doc);
}

export async function createKnowledgeType(data: Omit<KnowledgeType, "id" | "created_at" | "updated_at">): Promise<KnowledgeType> {
  const now = new Date().toISOString();
  const doc = { ...data, created_at: now, updated_at: now };
  const result = await col("knowledge_types").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as KnowledgeType;
}

export async function updateKnowledgeType(id: string, data: Partial<KnowledgeType>): Promise<KnowledgeType> {
  const { id: _id, ...rest } = data as any;
  await col("knowledge_types").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...rest, updated_at: new Date().toISOString() } }
  );
  return (await getKnowledgeType(id))!;
}

export async function deleteKnowledgeType(id: string): Promise<void> {
  const kt = await getKnowledgeType(id);
  await col("knowledge_types").deleteOne({ _id: new ObjectId(id) });
  if (kt) {
    await col("knowledge").deleteMany({ type: kt.name });
  }
}

// ---- Knowledge Records ----

export async function listKnowledge(opts?: { type?: string; search?: string; limit?: number }): Promise<KnowledgeRecord[]> {
  const filter: Record<string, any> = {};
  if (opts?.type) filter.type = opts.type;
  if (opts?.search) {
    filter._search_text = { $regex: opts.search, $options: "i" };
  }
  const limit = opts?.limit ?? 200;
  const docs = await col("knowledge").find(filter).sort({ updated_at: -1 }).limit(limit).toArray();
  return docs.map(fromDoc);
}

export async function getKnowledge(id: string): Promise<KnowledgeRecord | null> {
  try {
    const doc = await col("knowledge").findOne({ _id: new ObjectId(id) });
    return fromDoc(doc);
  } catch { return null; }
}

function buildSearchText(data: Record<string, any>): string {
  return Object.values(data)
    .filter((v) => v != null)
    .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
    .join(" ");
}

export async function createKnowledge(data: { type: string; data: Record<string, any>; created_by: string }): Promise<KnowledgeRecord> {
  const now = new Date().toISOString();
  const doc = {
    type: data.type,
    data: data.data,
    attachments: [],
    _search_text: buildSearchText(data.data),
    created_by: data.created_by,
    created_at: now,
    updated_at: now,
  };
  const result = await col("knowledge").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as any;
}

export async function updateKnowledge(id: string, data: Record<string, any>): Promise<KnowledgeRecord> {
  const update: Record<string, any> = { ...data, updated_at: new Date().toISOString() };
  if (data.data) {
    update._search_text = buildSearchText(data.data);
  }
  delete update.id;
  await col("knowledge").updateOne({ _id: new ObjectId(id) }, { $set: update });
  return (await getKnowledge(id))!;
}

export async function deleteKnowledge(id: string): Promise<void> {
  await col("knowledge").deleteOne({ _id: new ObjectId(id) });
}

export async function upsertKnowledge(
  type: string,
  matchOn: string[],
  data: Record<string, any>,
  createdBy: string,
): Promise<KnowledgeRecord> {
  const filter: Record<string, any> = { type };
  for (const field of matchOn) {
    filter[`data.${field}`] = data[field];
  }
  const now = new Date().toISOString();
  const result = await col("knowledge").findOneAndUpdate(
    filter,
    {
      $set: {
        data,
        _search_text: buildSearchText(data),
        updated_at: now,
      },
      $setOnInsert: {
        type,
        attachments: [],
        created_by: createdBy,
        created_at: now,
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return fromDoc(result);
}

export async function countKnowledgeByType(): Promise<Record<string, number>> {
  const pipeline = [
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ];
  const results = await col("knowledge").aggregate(pipeline).toArray();
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r._id] = r.count;
  }
  return counts;
}

export async function addKnowledgeAttachment(id: string, attachment: KnowledgeAttachment): Promise<void> {
  await col("knowledge").updateOne(
    { _id: new ObjectId(id) },
    { $push: { attachments: attachment } as any, $set: { updated_at: new Date().toISOString() } }
  );
}

export async function removeKnowledgeAttachment(id: string, s3Key: string): Promise<void> {
  await col("knowledge").updateOne(
    { _id: new ObjectId(id) },
    { $pull: { attachments: { s3_key: s3Key } } as any, $set: { updated_at: new Date().toISOString() } }
  );
}

// ── Chats ───────────────────────────────────────────────────────────────

export interface Chat {
  id: string;
  title: string;
  command_name: string | null;
  input_values: any[];
  status: "pending" | "running" | "completed" | "failed";
  cost_usd: number;
  session_id: string | null;
  model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6" | null;
  effort: "low" | "medium" | "high" | "max" | null;
  last_refresh_at?: string; // ISO timestamp of last daily briefing refresh
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  blocks?: { type: string; text?: string; label?: string; data?: any }[];
  ts: string;
}

// ── Conversations ───────────────────────────────────────────────────────
// The core entity: a persistent chat space with watched sources, notes, files,
// activity feed, situations, reminders, and optionally a linked structure entry.

export type RefreshPolicy = "on-visit" | "poll-5m" | "poll-15m" | "poll-1h";

export interface ExternalSources {
  drive?:   { file_ids: string[]; refresh: RefreshPolicy };
  hubspot?: { contact_ids: string[]; refresh: RefreshPolicy };
  monaco?:  { contact_ids: string[]; refresh: RefreshPolicy };
}

export interface Conversation {
  id: string;
  user_id?: string;
  title: string;

  // Watched sources
  watch_email_labels: string[];
  watch_slack_channels: string[];
  watch_email_threads: string[];

  // External per-conversation context sources (Drive files, CRM contacts).
  // Background sync / on-attach fetchers populate the external_source_cache
  // collection; the agent reads from that cache at run time.
  external_sources?: ExternalSources;

  // Context
  notes: string;
  important_files: { name: string; s3_key: string; parsed_text?: string; description?: string }[];

  // Messages
  messages: ChatMessage[];
  session_id: string | null;

  // AI config
  model: string | null;
  effort: string | null;

  // Features (moved from StructureEntry)
  situations: any[];
  reminders: any[];

  // Activity summary (updated on every new activity insert)
  last_activity_at: string | null;
  last_activity_preview: string | null;

  // Read tracking
  last_read_at: string | null;

  // Briefing
  last_refresh_at: string | null;

  // Briefing
  briefing_enabled: boolean; // whether the briefing agent should review this conversation

  // Optional structure template
  // When set, the conversation has a linked StructureEntry in structure_entries.
  // The conversation owns: messages, watched sources, notes, files, situations, reminders, activity.
  // The StructureEntry owns: typed data fields, field validation, warnings, status (draft/submitted).
  structure_command: string | null;
  structure_entry_id: string | null;

  created_at: string;
  updated_at: string;
}

export async function createConversation(opts: { title: string; structure_command?: string; user_id?: string }): Promise<Conversation> {
  const now = new Date().toISOString();
  const doc: Record<string, any> = {
    title: opts.title,
    watch_email_labels: [],
    watch_slack_channels: [],
    watch_email_threads: [],
    notes: "",
    important_files: [],
    messages: [],
    session_id: null,
    model: null,
    effort: null,
    situations: [],
    reminders: [],
    last_activity_at: null,
    last_activity_preview: null,
    last_read_at: null,
    last_refresh_at: null,
    briefing_enabled: false,
    structure_command: opts.structure_command ?? null,
    structure_entry_id: null,
    created_at: now,
    updated_at: now,
  };
  if (opts.user_id) doc.user_id = opts.user_id;
  const result = await col("conversations").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as Conversation;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    return fromDoc(await col("conversations").findOne({ _id: new ObjectId(id) }));
  } catch { return null; }
}

export async function listConversations(userId?: string): Promise<Conversation[]> {
  const filter: Record<string, any> = {};
  if (userId) filter.user_id = userId;
  const docs = await col("conversations").find(filter).sort({ updated_at: -1 }).toArray();
  return docs.map((d) => ({ ...fromDoc(d), messages: [] }));
}

export async function updateConversation(id: string, data: Partial<Omit<Conversation, "id" | "created_at">>): Promise<Conversation> {
  await col("conversations").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...data, updated_at: new Date().toISOString() } }
  );
  return (await getConversation(id))!;
}

export async function deleteConversation(id: string): Promise<void> {
  await col("conversations").deleteOne({ _id: new ObjectId(id) });
  // Also clean up activity records for this conversation
  await col("event_activity").deleteMany({ conversation_id: id });
}

export async function appendConversationMessage(id: string, message: ChatMessage): Promise<void> {
  if (!message || !message.role) {
    console.error(`[DB] Refusing to append null/invalid message to conversation ${id}:`, message);
    return;
  }
  await col("conversations").updateOne(
    { _id: new ObjectId(id) },
    { $push: { messages: message } as any, $set: { updated_at: new Date().toISOString() } }
  );
}

export async function setConversationSession(id: string, sessionId: string): Promise<void> {
  await col("conversations").updateOne(
    { _id: new ObjectId(id) },
    { $set: { session_id: sessionId, updated_at: new Date().toISOString() } }
  );
}

export async function updateConversationMessageBlock(conversationId: string, messageIndex: number, blockIndex: number, blockData: any): Promise<void> {
  await col("conversations").updateOne(
    { _id: new ObjectId(conversationId) },
    { $set: { [`messages.${messageIndex}.blocks.${blockIndex}.data`]: blockData, updated_at: new Date().toISOString() } }
  );
}

export async function listChats(): Promise<Chat[]> {
  const docs = await col("chats").find().sort({ updated_at: -1 }).toArray();
  return docs.map((d) => ({ ...fromDoc(d), messages: [] }));
}

export async function getChat(id: string): Promise<Chat | null> {
  try {
    return fromDoc(await col("chats").findOne({ _id: new ObjectId(id) }));
  } catch { return null; }
}

export async function createChat(opts: { title: string; command_name?: string; input_values?: any[]; model?: string; effort?: string }): Promise<Chat> {
  const now = new Date().toISOString();
  const doc = {
    title: opts.title,
    command_name: opts.command_name ?? null,
    input_values: opts.input_values ?? [],
    status: "pending" as const,
    cost_usd: 0,
    session_id: null,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    messages: [],
    created_at: now,
    updated_at: now,
  };
  const result = await col("chats").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as Chat;
}

export async function updateChatStatus(id: string, status: Chat["status"], cost_usd?: number): Promise<void> {
  const update: Record<string, any> = { status, updated_at: new Date().toISOString() };
  if (cost_usd !== undefined) update.cost_usd = cost_usd;
  await col("chats").updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );
}

export async function resetChat(id: string): Promise<void> {
  await col("chats").updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "pending", session_id: null, messages: [], updated_at: new Date().toISOString() } }
  );
  await col("structure_entries").deleteMany({ chat_id: id });
}

export async function updateChat(id: string, data: Partial<Pick<Chat, "title" | "model" | "effort">>): Promise<Chat> {
  await col("chats").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...data, updated_at: new Date().toISOString() } }
  );
  return (await getChat(id))!;
}

export async function deleteChat(id: string): Promise<void> {
  await col("chats").deleteOne({ _id: new ObjectId(id) });
  await col("structure_entries").deleteMany({ chat_id: id });
}

export async function appendChatMessage(id: string, message: ChatMessage): Promise<void> {
  if (!message || !message.role) {
    console.error(`[DB] Refusing to append null/invalid message to chat ${id}:`, message);
    return;
  }
  await col("chats").updateOne(
    { _id: new ObjectId(id) },
    { $push: { messages: message } as any, $set: { updated_at: new Date().toISOString() } }
  );
}

export async function setChatSession(id: string, sessionId: string): Promise<void> {
  await col("chats").updateOne(
    { _id: new ObjectId(id) },
    { $set: { session_id: sessionId, updated_at: new Date().toISOString() } }
  );
}

// ── Structure Entries ───────────────────────────────────────────────────

export interface StructureEntry {
  id: string;
  chat_id: string;
  agent_description?: string; // rich identifying description set by agent (used for dedup, labels, tracing)
  agent_trace?: string;
  agent_cost?: number;
  command_name: string;
  data: Record<string, any>;
  status: "draft" | "submitted";
  warning_explanations?: Record<string, string>; // field_name → explanation for why it's empty
  warnings: string[];
  created_at: string;
  updated_at: string;
}

export async function listStructureEntries(chatId: string, commandName?: string): Promise<StructureEntry[]> {
  const filter: Record<string, any> = { chat_id: chatId };
  if (commandName) filter.command_name = commandName;
  const docs = await col("structure_entries").find(filter).sort({ created_at: 1 }).toArray();
  return docs.map(fromDoc);
}

export async function getStructureEntry(id: string): Promise<StructureEntry | null> {
  try {
    return fromDoc(await col("structure_entries").findOne({ _id: new ObjectId(id) }));
  } catch { return null; }
}

export async function createStructureEntry(data: { chat_id: string; command_name: string; data: Record<string, any>; agent_description?: string }): Promise<StructureEntry> {
  const now = new Date().toISOString();
  const doc = { chat_id: data.chat_id, command_name: data.command_name, data: data.data, agent_description: data.agent_description ?? null, status: "draft", warnings: [], created_at: now, updated_at: now };
  const result = await col("structure_entries").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc } as StructureEntry;
}

export async function updateStructureEntry(id: string, data: Partial<Pick<StructureEntry, "data" | "status" | "warnings">>): Promise<StructureEntry> {
  await col("structure_entries").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...data, updated_at: new Date().toISOString() } }
  );
  return (await getStructureEntry(id))!;
}

export async function updateStructureEntryMeta(id: string, meta: { agent_trace?: string; agent_cost?: number }): Promise<void> {
  await col("structure_entries").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...meta, updated_at: new Date().toISOString() } }
  );
}

export async function deleteStructureEntry(id: string): Promise<void> {
  await col("structure_entries").deleteOne({ _id: new ObjectId(id) });
}

// ── Evidence Cache ──────────────────────────────────────────────────────

export async function getEvidenceCache(sourceType: string, sourceId: string): Promise<string | null> {
  const doc = await col("evidence_cache").findOne({ source_type: sourceType, source_id: sourceId });
  return doc?.text ?? null;
}

export async function setEvidenceCache(sourceType: string, sourceId: string, text: string): Promise<void> {
  await col("evidence_cache").updateOne(
    { source_type: sourceType, source_id: sourceId },
    { $set: { text, cached_at: new Date().toISOString() } },
    { upsert: true },
  );
}

// ── Briefing Runs ───────────────────────────────────────────────────────

export interface BriefingRun {
  id: string;
  trace: string;
  actions: any[];
  cost_usd: number;
  created_at: string;
}

export async function saveBriefingRun(trace: string, actions: any[], costUsd: number, extraInstructions?: string | null): Promise<BriefingRun> {
  const now = new Date().toISOString();
  const doc = { trace, actions, cost_usd: costUsd, created_at: now, extra_instructions: extraInstructions || null };
  const result = await col("briefing_runs").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc };
}

export async function getLatestBriefingRun(): Promise<BriefingRun | null> {
  const doc = await col("briefing_runs").findOne({}, { sort: { created_at: -1 } });
  return doc ? fromDoc(doc) : null;
}

export async function listBriefingRuns(limit = 10): Promise<BriefingRun[]> {
  const docs = await col("briefing_runs").find().sort({ created_at: -1 }).limit(limit).toArray();
  return docs.map(fromDoc);
}

// ── Event Activity ──────────────────────────────────────────────────────

export interface EventActivity {
  id: string;
  conversation_id: string;
  type: "email" | "slack";
  title: string;
  subject?: string;  // email subject line (shown on title row)
  preview: string;   // message body snippet
  timestamp: string;
  thread_id?: string;
  message_id?: string;
  channel?: string;
  message_ts?: string;
  from?: string;
  archived?: boolean;  // email: thread no longer in inbox
  sender_id?: string;  // normalized sender: email address or Slack user ID
}

/** Returns true if a new row was inserted, false if it was a dedup no-op. */
export async function insertActivity(item: Omit<EventActivity, "id">): Promise<boolean> {
  // Dedup by conversation_id + type + message identifier
  const dedupKey = item.type === "email"
    ? { conversation_id: item.conversation_id, type: item.type, message_id: item.message_id }
    : { conversation_id: item.conversation_id, type: item.type, message_ts: item.message_ts, channel: item.channel };

  const result = await col("event_activity").updateOne(
    dedupKey,
    { $setOnInsert: item },
    { upsert: true },
  );
  const isNew = result.upsertedCount > 0;

  // If this was a new insert (not a dedup), update the conversation's last activity summary
  // Only update if this item is newer than the current last_activity_at
  if (isNew && item.conversation_id) {
    const icon = item.type === "email" ? "📧" : "💬";
    const preview = `${icon} ${item.title}${item.subject ? ": " + item.subject : ""}${item.preview ? "\n" + item.preview : ""}`.slice(0, 600);
    try {
      await col("conversations").updateOne(
        {
          _id: new ObjectId(item.conversation_id),
          $or: [
            { last_activity_at: { $lt: item.timestamp } },
            { last_activity_at: null },
            { last_activity_at: { $exists: false } },
          ],
        },
        {
          $set: {
            last_activity_at: item.timestamp,
            last_activity_preview: preview,
            updated_at: new Date().toISOString(),
          },
        },
      );
    } catch {}
  }

  return isNew;
}

export async function deleteActivityByChannel(conversationId: string, channelId: string): Promise<number> {
  const result = await col("event_activity").deleteMany({ conversation_id: conversationId, type: "slack", channel: channelId });
  return result.deletedCount;
}

export async function deleteActivityByEmailLabel(conversationId: string, labelName: string): Promise<number> {
  // Email activities don't store label directly — they store thread_id.
  // We'd need to know which threads belong to the label, which is expensive.
  // For now, just delete all email activity for this conversation (they'll be re-populated for remaining labels)
  // This is safe because backfill runs immediately after
  return 0; // Skip — too complex to match label to threads
}

export async function deleteActivityByEmailThread(conversationId: string, threadId: string): Promise<number> {
  const result = await col("event_activity").deleteMany({ conversation_id: conversationId, type: "email", thread_id: threadId });
  return result.deletedCount;
}

// ── External Source Cache ───────────────────────────────────────────────
// Warm cache for per-conversation external context (Drive files, HubSpot
// contacts, Monaco contacts). Populated on attach + by a background sync
// worker (Phase 2+). Agent run reads from this at prompt-assembly time.

export interface ExternalSourceCacheEntry {
  id: string;
  conversation_id: string;
  source: "drive" | "hubspot" | "monaco";
  ref_id: string;                    // file_id for drive, contact_id for CRM
  data: Record<string, any>;         // shape is source-specific
  fetched_at: string;
  status: "ok" | "error";
  error?: string;
}

export async function upsertExternalCache(entry: Omit<ExternalSourceCacheEntry, "id">): Promise<void> {
  await col("external_source_cache").updateOne(
    { conversation_id: entry.conversation_id, source: entry.source, ref_id: entry.ref_id },
    { $set: entry },
    { upsert: true },
  );
}

export async function listExternalCache(conversationId: string): Promise<ExternalSourceCacheEntry[]> {
  const docs = await col("external_source_cache").find({ conversation_id: conversationId }).toArray();
  return docs.map(fromDoc);
}

export async function getExternalCacheEntry(conversationId: string, source: ExternalSourceCacheEntry["source"], refId: string): Promise<ExternalSourceCacheEntry | null> {
  return fromDoc(await col("external_source_cache").findOne({ conversation_id: conversationId, source, ref_id: refId }));
}

export async function deleteExternalCacheEntry(conversationId: string, source: ExternalSourceCacheEntry["source"], refId: string): Promise<void> {
  await col("external_source_cache").deleteOne({ conversation_id: conversationId, source, ref_id: refId });
}

// ---- Chat Logs ----

export interface ChatLog {
  id: string;
  conversation_id: string;
  message_preview: string;
  ip: string;
  user_agent?: string;
  timestamp: string;
}

export async function insertChatLog(log: Omit<ChatLog, "id">): Promise<void> {
  await col("chat_logs").insertOne(log);
}

export async function listChatLogs(filter?: { ip?: string }, limit = 200, offset = 0): Promise<ChatLog[]> {
  const q: Record<string, any> = {};
  if (filter?.ip) q.ip = filter.ip;
  const docs = await col("chat_logs").find(q).sort({ timestamp: -1 }).skip(offset).limit(limit).toArray();
  return docs.map(fromDoc);
}

export async function listChatLogIps(): Promise<string[]> {
  const ips = await col("chat_logs").distinct("ip");
  return ips;
}

export async function listActivity(conversationId: string, since?: string): Promise<EventActivity[]> {
  const filter: Record<string, any> = { conversation_id: conversationId };
  if (since) filter.timestamp = { $gte: since };
  const docs = await col("event_activity").find(filter).sort({ timestamp: -1 }).limit(1000).toArray();
  return docs.map(fromDoc);
}

// ── Read/Unread tracking ─────────────────────────────────────────────

export async function setLastReadAt(conversationId: string, timestamp: string): Promise<void> {
  await col("conversations").updateOne(
    { _id: new ObjectId(conversationId) },
    { $set: { last_read_at: timestamp } },
  );
}

export async function clearLastReadAt(conversationId: string): Promise<void> {
  // Set to epoch so all activity counts as unread (null means "never tracked" which defaults to read)
  await col("conversations").updateOne(
    { _id: new ObjectId(conversationId) },
    { $set: { last_read_at: "1970-01-01T00:00:00.000Z" } },
  );
}

