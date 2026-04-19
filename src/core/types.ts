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
  action_effort: "low" | "medium" | "high" | "max" | null;
  action_mode: "auto" | "staged";
  auto_execute_actions: string[] | null; // if set, only these action types auto-execute; rest get staged
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
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "awaiting_approval"
    | "approved"
    | "rejected";
  agent_result: string | null;
  agent_actions?: { action: string; [key: string]: any }[];
  agent_steps?: { type: string; data: string; ts: number }[];
  slack_notify_ts?: string;
  slack_notify_channel?: string;
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

// ---- Knowledge Database ----

export interface KnowledgeTypeField {
  name: string;
  type: "string" | "number" | "date" | "boolean" | "attachment" | "select" | "multi_select";
  required?: boolean;
  description?: string;
  options?: string[];
}

export interface KnowledgeType {
  id: string;
  name: string;        // unique slug like "signed_contract"
  label: string;       // display name
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
