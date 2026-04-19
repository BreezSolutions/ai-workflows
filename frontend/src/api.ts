export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: "cron" | "slack_message" | "gmail_poll" | "manual";
  trigger_config: Record<string, any>;
  list_source: "supabase" | "airtable" | "gmail" | "slack" | "ai" | null;
  list_config: Record<string, any>;
  ai_filter_prompt: string | null;
  skip_condition: SkipCondition[] | SkipCondition | null;
  action_prompt: string;
  action_model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
  action_mode: "auto" | "staged";
  auto_execute_actions: string[] | null;
  action_effort: "low" | "medium" | "high" | "max" | null;
  memory_dir: string | null;
  slack_notify_channel: string | null;
  slack_notify_detail: boolean;
  slack_notify_header: string | null;
  slack_notify_skip_noaction: boolean;
  slack_action_channel: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunLog {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ExecutionRun {
  id: string;
  workflow_id: string;
  triggered_by: string;
  status: "running" | "completed" | "failed" | "aborted";
  items_total: number;
  items_completed: number;
  cost_usd: number;
  logs: RunLog[];
  started_at: string;
  completed_at: string | null;
}

export interface ExecutionItem {
  id: string;
  run_id: string;
  item_data: Record<string, any>;
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval" | "approved" | "rejected";
  agent_result: string | null;
  agent_actions?: { action: string; [key: string]: any }[];
  agent_steps?: { type: string; data: string; ts: number }[];
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
}

export interface SkipCondition {
  source: "knowledge" | "supabase" | "no_external_reply" | "max_messages" | "recent_activity";
  knowledge_type?: string;
  table?: string;
  schema?: string;
  match: { item_field: string; record_field: string }[];
  where?: Record<string, string>;
  max_messages?: number;
  min_age_minutes?: number;
}

export type WorkflowCreate = Omit<Workflow, "id" | "created_at" | "updated_at">;
export type WorkflowUpdate = Partial<WorkflowCreate>;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Workflows
export const listWorkflows = () => request<Workflow[]>("/workflows");
export const getWorkflow = (id: string) => request<Workflow>(`/workflows/${id}`);
export const createWorkflow = (data: WorkflowCreate) =>
  request<Workflow>("/workflows", { method: "POST", body: JSON.stringify(data) });
export const updateWorkflow = (id: string, data: WorkflowUpdate) =>
  request<Workflow>(`/workflows/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteWorkflow = (id: string) =>
  request<void>(`/workflows/${id}`, { method: "DELETE" });

// Executions
export const listRuns = (workflowId?: string) =>
  request<ExecutionRun[]>(`/executions${workflowId ? `?workflow_id=${workflowId}` : ""}`);
export const listItems = (runId: string) =>
  request<ExecutionItem[]>(`/executions/${runId}/items`);
export const abortRun = (runId: string) =>
  request<{ ok: boolean }>(`/executions/${runId}/abort`, { method: "POST" });

// Triggers
export const triggerWorkflow = (id: string, limit?: number) =>
  request<{ run_id: string; status: string }>(`/workflows/${id}/trigger`, {
    method: "POST",
    body: limit ? JSON.stringify({ limit }) : undefined,
  });
export const testWorkflow = (id: string, item?: Record<string, any>, count?: number) =>
  request<{ run_id: string; status: string }>(`/workflows/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ item, count }),
  });
export const fetchTestItems = (id: string) =>
  request<Record<string, any>[]>(`/workflows/${id}/test-items`);
export const fetchThreadPreview = (workflowId: string, threadId: string) =>
  request<Record<string, any>[]>(`/workflows/${workflowId}/test-items/thread/${threadId}`);

// Preview
export const previewListCount = (listSource: string, listConfig: Record<string, any>, preview?: boolean, skipCondition?: SkipCondition[] | SkipCondition | null) =>
  request<{ count: number; items?: Record<string, any>[] }>("/workflows/preview-list", {
    method: "POST",
    body: JSON.stringify({ list_source: listSource, list_config: listConfig, preview, skip_condition: skipCondition || undefined }),
  });

// Activity
export const listCompletedItems = (workflowId?: string) =>
  request<ExecutionItem[]>(`/executions/completed/items${workflowId ? `?workflow_id=${workflowId}` : ""}`);

// Slack
export interface SlackChannel { id: string; name: string; }
export const listSlackChannels = () => request<SlackChannel[]>("/slack/channels");

export interface SlackMessage { ts: string; text: string; user: string; thread_ts?: string; reply_count: number; blocks?: any[]; }
export const listSlackMessages = (channelId: string) =>
  request<SlackMessage[]>(`/slack/channels/${channelId}/messages`);
export const listSlackThread = (channelId: string, threadTs: string) =>
  request<SlackMessage[]>(`/slack/channels/${channelId}/threads/${threadTs}`);

export interface SlackFile { id: string; name: string; mimetype: string; size: number; url_private: string; user: string; timestamp: number; }
export const listSlackFiles = (channelId: string) =>
  request<SlackFile[]>(`/slack/channels/${channelId}/files`);

export const testWorkflowWithTrigger = (id: string, triggerData: Record<string, any>) =>
  request<{ run_id: string; status: string }>(`/workflows/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ triggerData }),
  });

// Approvals
export const listPendingApprovals = (workflowId?: string) =>
  request<ExecutionItem[]>(`/approvals${workflowId ? `?workflow_id=${workflowId}` : ""}`);
export const approveItem = (id: string, actionIndices?: number[]) =>
  request<ExecutionItem>(`/approvals/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionIndices }),
  });
export const rejectItem = (id: string, actionIndex?: number) =>
  request<ExecutionItem>(`/approvals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionIndex }),
  });
export const clearAllApprovals = (workflowId?: string) =>
  request<{ deleted: number }>(`/approvals${workflowId ? `?workflow_id=${workflowId}` : ""}`, { method: "DELETE" });
export const updateApprovalAction = (itemId: string, index: number, action: Record<string, any>) =>
  request<ExecutionItem>(`/approvals/${itemId}/actions/${index}`, {
    method: "PUT",
    body: JSON.stringify(action),
  });
export const suggestPromptChange = (data: {
  itemId: string;
  actionIndex: number;
  reason: string;
  type: "reject" | "edit";
}) =>
  request<{ suggestion: string; currentPrompt: string; workflowId: string }>(
    "/approvals/suggest-prompt-change",
    { method: "POST", body: JSON.stringify(data) },
  );

// Gmail thread messages (full bodies for approval detail)
export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  body_html?: string | null;
}
export const fetchGmailThreadMessages = (threadId: string, limit = 10) =>
  request<GmailMessage[]>(`/gmail/threads/${threadId}/messages?limit=${limit}`);

export const fetchGmailMessageBody = (messageId: string) =>
  request<GmailMessage>(`/gmail/messages/${messageId}/body`);

export interface GmailLabel { id: string; name: string; }
export const listGmailLabels = () => request<GmailLabel[]>("/gmail/labels");

export interface GmailThreadSummary {
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  messageCount: number;
  hasAttachments?: boolean;
}
export const searchGmailThreads = (q?: string, labelId?: string) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (labelId) params.set("labelId", labelId);
  return request<GmailThreadSummary[]>(`/gmail/search?${params}`);
};

export interface GmailAttachment {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  from: string;
  date: string;
}
export const listGmailThreadAttachments = (threadId: string) =>
  request<GmailAttachment[]>(`/gmail/threads/${threadId}/attachments`);

// Knowledge
export interface KnowledgeTypeField {
  name: string;
  type: "string" | "number" | "date" | "boolean" | "attachment" | "select" | "multi_select";
  required?: boolean;
  description?: string;
  options?: string[];
}

export interface KnowledgeType {
  id: string;
  name: string;
  label: string;
  description: string;
  fields: KnowledgeTypeField[];
  created_at: string;
  updated_at: string;
}

export interface KnowledgeAttachment {
  filename: string;
  s3_key: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
}

export interface KnowledgeRecord {
  id: string;
  type: string;
  data: Record<string, any>;
  attachments: KnowledgeAttachment[];
  created_at: string;
  updated_at: string;
  created_by: string;
}

export const listKnowledgeTypes = () => request<KnowledgeType[]>("/knowledge/types");
export const createKnowledgeType = (data: Omit<KnowledgeType, "id" | "created_at" | "updated_at">) =>
  request<KnowledgeType>("/knowledge/types", { method: "POST", body: JSON.stringify(data) });
export const updateKnowledgeType = (id: string, data: Partial<KnowledgeType>) =>
  request<KnowledgeType>(`/knowledge/types/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteKnowledgeType = (id: string) =>
  request<void>(`/knowledge/types/${id}`, { method: "DELETE" });

export const listKnowledgeRecords = (type?: string, search?: string) => {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (search) params.set("search", search);
  return request<KnowledgeRecord[]>(`/knowledge/records?${params}`);
};
export const getKnowledgeRecord = (id: string) => request<KnowledgeRecord>(`/knowledge/records/${id}`);
export const createKnowledgeRecord = (data: { type: string; data: Record<string, any>; created_by: string }) =>
  request<KnowledgeRecord>("/knowledge/records", { method: "POST", body: JSON.stringify(data) });
export const updateKnowledgeRecord = (id: string, data: Record<string, any>) =>
  request<KnowledgeRecord>(`/knowledge/records/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteKnowledgeRecord = (id: string) =>
  request<void>(`/knowledge/records/${id}`, { method: "DELETE" });
export const getKnowledgeCounts = () => request<Record<string, number>>("/knowledge/counts");

export const uploadKnowledgeAttachment = async (recordId: string, file: File): Promise<KnowledgeAttachment> => {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/knowledge/records/${recordId}/attachments`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
};
export const getAttachmentUrl = (recordId: string, s3Key: string) =>
  request<{ url: string }>(`/knowledge/records/${recordId}/attachments/${encodeURIComponent(s3Key)}`);

// Connections
export interface Connection {
  id: string;
  service: string;
  email?: string;
  connected: boolean;
  connected_at: string;
  scopes?: string[];
}
export const listConnections = () => request<Connection[]>("/connections");
export const getGmailAuthUrl = () => request<{ url: string }>("/connections/gmail/auth-url");
export const getSlackAuthUrl = () => request<{ url: string }>("/connections/slack/auth-url");
export const disconnectService = (service: string) =>
  request<void>(`/connections/${service}`, { method: "DELETE" });

// Folders
export interface PinnedSource {
  type: "email_thread" | "slack_channel" | "slack_thread" | "file" | "note";
  label: string;
  thread_id?: string;
  channel_id?: string;
  thread_ts?: string;
  url?: string;
  text?: string;
  last_seen?: string;
  last_activity?: string;
  s3_key?: string;
  mime_type?: string;
  extracted_text?: string;
  message_count?: number;
  last_snippet?: string;
}

export const getSetting = (key: string) =>
  request<{ value: string | null }>(`/settings/${key}`).then((r) => r.value).catch(() => null);
export const setSetting = (key: string, value: string) =>
  request<{ ok: boolean }>(`/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) });

// ── Chats ───────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  blocks?: { type: string; text?: string; label?: string; data?: any }[];
  ts: string;
}

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
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export const listChats = () => request<Chat[]>("/chats");
export const getChat = (id: string) => request<Chat>(`/chats/${id}`);
export const createJob = (command_name: string, input_values: any[], model?: string, effort?: string) =>
  request<Chat>("/chats", { method: "POST", body: JSON.stringify({ command_name, input_values, model, effort }) });
export const deleteChat = (id: string) =>
  request<void>(`/chats/${id}`, { method: "DELETE" });
export const resetJob = (id: string) =>
  request<Chat>(`/chats/${id}/reset`, { method: "POST" });
export const respondToChatPermission = (requestId: string, allow: boolean, message?: string) =>
  request<{ ok: boolean }>(`/chats/permissions/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ allow, message }),
  });
export const resolveInputs = (command_name: string, query: string) =>
  request<{ values: string }>("/chats/resolve-inputs", {
    method: "POST",
    body: JSON.stringify({ command_name, query }),
  });

// ── Structure Config ────────────────────────────────────────────────────

export interface StructureFieldDef {
  name: string;
  label: string;
  description?: string;
  type: "boolean" | "number" | "string" | "date" | "email_thread" | "email_thread_array" | "pdf" | "enum" | "todo" | "link";
  linked_table?: string;
  multi?: boolean;
  recommended_priority?: "high" | "medium" | "low";
  requires_evidence?: boolean;
  options?: string[];
  render_as?: "markdown";
  // Legacy fields (kept for backward compat with existing config data)
  required?: boolean;
  presence?: string;
  presence_reason?: string;
  validations?: { type: string; value: string; message: string }[];
  importance?: "critical" | "important" | "minor";
  stale_after_days?: number;
}

export interface StructureInput {
  name: string;
  label: string;
  description?: string;
  type: "number" | "string";
  source?: { table: string; column: string };
}

export interface StructureCommand {
  name: string;
  label: string;
  description: string;
  research_instructions?: string;
  prep_brief_template?: string;
  multi: boolean;
  primary?: boolean;
  input?: StructureInput;
  fields: StructureFieldDef[];
}

export interface StructureConfig {
  commands: StructureCommand[];
}

export const getStructureConfig = () => request<StructureConfig>("/structures/config");
export const saveStructureConfig = (config: StructureConfig) =>
  request<StructureConfig>("/structures/config", { method: "PUT", body: JSON.stringify(config) });

// ── Structure Entries ───────────────────────────────────────────────────

export interface StructureEntry {
  id: string;
  chat_id: string;
  command_name: string;
  data: Record<string, any>;
  status: "draft" | "submitted";
  warnings: string[];
  agent_description?: string;
  agent_trace?: string;
  agent_cost?: number;
  created_at: string;
  updated_at: string;
}

export const listStructureEntries = (chatId: string, command?: string) => {
  const params = new URLSearchParams({ chat_id: chatId });
  if (command) params.set("command", command);
  return request<StructureEntry[]>(`/structures/entries?${params}`);
};
export const getStructureAttachmentUrl = (s3Key: string) =>
  request<{ url: string }>(`/structures/attachments/${encodeURIComponent(s3Key)}`);

// ── Auth ──────────────────────────────────────────────────────────────

export interface AppUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export const getAuthUser = () => request<AppUser>("/auth/me");
export const getGoogleLoginUrl = () => request<{ url: string }>("/auth/google-url");
export const logout = () => request<void>("/auth/logout", { method: "POST" });

// ── Conversations ─────────────────────────────────────────────────────

export type RefreshPolicy = "on-visit" | "poll-5m" | "poll-15m" | "poll-1h";

export interface ExternalSources {
  drive?:   { file_ids: string[]; refresh: RefreshPolicy };
  hubspot?: { contact_ids: string[]; refresh: RefreshPolicy };
  monaco?:  { contact_ids: string[]; refresh: RefreshPolicy };
}

export interface ConversationSummary {
  id: string;
  title: string;
  structure_command: string | null;
  structure_entry_id: string | null;
  watch_email_labels: string[];
  watch_slack_channels: string[];
  watch_email_threads: string[];
  external_sources?: ExternalSources;
  situations: { id: string; title: string; priority?: string; resolved: boolean }[];
  reminders: { id: string; title: string; date: string; time?: string; resolved: boolean; overdue?: boolean }[];
  briefing_enabled: boolean;
  last_activity_at: string | null;
  last_activity_preview: string | null;
  has_unread: boolean;
  last_read_at: string | null;
  updated_at: string;
}

export interface Conversation extends ConversationSummary {
  notes: string;
  important_files: { name: string; s3_key: string; parsed_text?: string; description?: string }[];
  messages: ChatMessage[];
  session_id: string | null;
  model: string | null;
  effort: string | null;
  last_refresh_at: string | null;
  created_at: string;
}

export const listConversations = () => request<ConversationSummary[]>("/conversations");
export const getConversation = (id: string) => request<Conversation>(`/conversations/${id}`);
export const createConversation = (title: string, structure_command?: string) =>
  request<Conversation>("/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, structure_command }) });
// ── Drive (Google Drive file linking) ───────────────────────────────
export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  iconLink?: string;
  modifiedTime?: string;
  webViewLink?: string;
}
export const searchDriveFiles = (query: string) =>
  request<{ files: DriveFileSummary[] }>(`/drive/search?q=${encodeURIComponent(query)}`).then(r => r.files);
export const attachDriveFile = (conversation_id: string, file_id: string) =>
  request<{ ok: boolean; file: { id: string; name: string; mime_type: string } }>("/drive/attach", {
    method: "POST",
    body: JSON.stringify({ conversation_id, file_id }),
  });
export const detachDriveFile = (conversation_id: string, file_id: string) =>
  request<{ ok: boolean }>(`/drive/attach?conversation_id=${encodeURIComponent(conversation_id)}&file_id=${encodeURIComponent(file_id)}`, {
    method: "DELETE",
  });

export interface ExternalCacheEntry {
  id: string;
  conversation_id: string;
  source: "drive" | "hubspot" | "monaco";
  ref_id: string;
  data: Record<string, any>;
  fetched_at: string;
  status: "ok" | "error";
  error?: string;
}
export const getExternalContext = (conversation_id: string) =>
  request<{ entries: ExternalCacheEntry[] }>(`/conversations/${conversation_id}/external-context`).then(r => r.entries);

export const updateConversation = (id: string, data: Partial<Pick<Conversation, "title" | "notes" | "important_files" | "watch_email_labels" | "watch_slack_channels" | "watch_email_threads" | "structure_command" | "model" | "effort" | "external_sources">>) =>
  request<Conversation>(`/conversations/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
export const deleteConversation = (id: string) =>
  request<void>(`/conversations/${id}`, { method: "DELETE" });
export const getConversationMessages = (id: string) =>
  request<ChatMessage[]>(`/conversations/${id}/messages`);
export const getConversationActivity = (id: string) =>
  request<any[]>(`/conversations/${id}/activity`);
export const markConversationRead = (id: string) =>
  request<void>(`/conversations/${id}/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
export const markConversationUnread = (id: string) =>
  request<void>(`/conversations/${id}/read`, { method: "DELETE" });
