import { useState, useEffect, useRef, useCallback } from "react";
import {
  type ExecutionItem,
  type GmailMessage,
  type SlackMessage,
  approveItem,
  rejectItem,
  fetchGmailThreadMessages,
  listSlackMessages,
  listSlackThread,
  updateApprovalAction,
  suggestPromptChange,
  updateWorkflow,
} from "../api";
import { parseAgentResult, type ParsedAction, ItemDataCard } from "./AgentResultCard";

interface FlatAction {
  item: ExecutionItem;
  action: ParsedAction;
  actionIndex: number;
}

function flattenItems(items: ExecutionItem[]): FlatAction[] {
  const flat: FlatAction[] = [];
  for (const item of items) {
    const actions =
      item.agent_actions?.length
        ? item.agent_actions
        : item.agent_result
          ? parseAgentResult(item.agent_result).actions
          : [];
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].action === "none") continue;
      if (["executed", "queued", "rejected"].includes((actions[i] as any)._status)) continue;
      flat.push({ item, action: actions[i], actionIndex: i });
    }
  }
  return flat;
}

function extractName(emailStr: string): string {
  const match = emailStr.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return emailStr.split("@")[0];
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

// ---- Context panels ----

function GmailThreadPanel({ threadId }: { threadId: string }) {
  const [messages, setMessages] = useState<GmailMessage[] | null>(null);
  const [error, setError] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(null);
    setError(false);
    fetchGmailThreadMessages(threadId, 10)
      .then(setMessages)
      .catch(() => setError(true));
  }, [threadId]);

  useEffect(() => {
    if (messages) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (error) return <div className="text-red-700 text-sm p-4">Failed to load thread</div>;
  if (!messages) return <div className="text-gray-500 text-sm p-4 animate-pulse">Loading thread...</div>;
  if (messages.length === 0) return <div className="text-gray-500 text-sm p-4">No messages found</div>;

  return (
    <div className="space-y-3 p-4 overflow-y-auto max-h-full">
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">
        {messages.length} message{messages.length !== 1 ? "s" : ""} in thread
      </div>
      {messages.map((msg, i) => (
        <div
          key={msg.id}
          className={`rounded-lg p-3 text-sm ${
            i === messages.length - 1
              ? "bg-gray-100 border border-gray-200"
              : "bg-white/50 border border-gray-200/50"
          }`}
        >
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="font-medium text-gray-900 text-sm">
              {extractName(msg.from)}
            </span>
            <span className="text-xs text-gray-500">{formatDate(msg.date)}</span>
          </div>
          <div className="text-xs text-gray-500 mb-1.5 space-y-0.5">
            {msg.to && <div>To: {msg.to}</div>}
            {msg.cc && <div>Cc: {msg.cc}</div>}
            {msg.bcc && <div>Bcc: {msg.bcc}</div>}
          </div>
          <div className="text-gray-600 text-sm whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
            {msg.body || msg.snippet || "(empty)"}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function SlackThreadPanel({ channelId, threadTs }: { channelId: string; threadTs?: string }) {
  const [messages, setMessages] = useState<SlackMessage[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setMessages(null);
    setError(false);
    const fetcher = threadTs
      ? listSlackThread(channelId, threadTs)
      : listSlackMessages(channelId);
    fetcher.then((msgs) => setMessages(msgs.slice(-15))).catch(() => setError(true));
  }, [channelId, threadTs]);

  if (error) return <div className="text-red-700 text-sm p-4">Failed to load messages</div>;
  if (!messages) return <div className="text-gray-500 text-sm p-4 animate-pulse">Loading messages...</div>;

  return (
    <div className="space-y-2 p-4 overflow-y-auto max-h-full">
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">
        {threadTs ? "Thread" : "Channel"} messages
      </div>
      {messages.map((msg) => (
        <div key={msg.ts} className="flex gap-2 text-sm">
          <span className="text-purple-700 font-medium shrink-0 w-20 truncate text-xs mt-0.5">
            {msg.user}
          </span>
          <span className="text-gray-700 whitespace-pre-wrap">{msg.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Proposed action display (right panel) ----

function ProposedEmailAction({
  action,
  editing,
  editedAction,
  setEditedAction,
}: {
  action: ParsedAction;
  editing: boolean;
  editedAction: ParsedAction;
  setEditedAction: (a: ParsedAction) => void;
}) {
  const isReply = action.action === "reply_email";
  const isForward = action.action === "forward_email";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-blue-700 text-lg">{isReply ? "\u21A9" : isForward ? "\u21AA" : "\u2709"}</span>
        <span className="text-base font-medium text-gray-900">
          {isReply ? "Reply" : isForward ? "Forward" : "New Email"}
        </span>
      </div>

      <div className="space-y-2">
        {(action.to || action.action === "send_email") && (
          <div>
            <label className="text-xs text-gray-500 block mb-1">To</label>
            {editing ? (
              <input
                className="w-full bg-gray-100 border border-gray-200 rounded px-3 py-1.5 text-sm text-gray-900"
                value={Array.isArray(editedAction.to) ? editedAction.to.join(", ") : editedAction.to || ""}
                onChange={(e) => setEditedAction({ ...editedAction, to: e.target.value.split(",").map((s: string) => s.trim()) })}
              />
            ) : (
              <div className="text-sm text-gray-900">
                {Array.isArray(action.to) ? action.to.join(", ") : action.to}
              </div>
            )}
          </div>
        )}

        {action.subject && (
          <div>
            <label className="text-xs text-gray-500 block mb-1">Subject</label>
            {editing ? (
              <input
                className="w-full bg-gray-100 border border-gray-200 rounded px-3 py-1.5 text-sm text-gray-900"
                value={editedAction.subject || ""}
                onChange={(e) => setEditedAction({ ...editedAction, subject: e.target.value })}
              />
            ) : (
              <div className="text-sm text-gray-900">{action.subject}</div>
            )}
          </div>
        )}

        {(action.cc?.length > 0 || editing) && (
          <div>
            <label className="text-xs text-gray-500 block mb-1">Cc</label>
            {editing ? (
              <input
                className="w-full bg-gray-100 border border-gray-200 rounded px-3 py-1.5 text-sm text-gray-900"
                value={Array.isArray(editedAction.cc) ? editedAction.cc.join(", ") : editedAction.cc || ""}
                onChange={(e) => setEditedAction({ ...editedAction, cc: e.target.value ? e.target.value.split(",").map((s: string) => s.trim()) : [] })}
              />
            ) : (
              <div className="text-sm text-gray-900">
                {Array.isArray(action.cc) ? action.cc.join(", ") : action.cc}
              </div>
            )}
          </div>
        )}

        {isReply && action.thread_id && (
          <div>
            <label className="text-xs text-gray-500 block mb-1">Thread</label>
            <div className="text-xs text-gray-600 font-mono">
              {action.thread_id}
              <a
                href={`https://mail.google.com/mail/u/0/#inbox/${action.thread_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:text-blue-700 font-sans ml-2"
              >
                open in Gmail
              </a>
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-gray-500 block mb-1">Body</label>
          {editing ? (
            <textarea
              className="w-full bg-gray-100 border border-gray-200 rounded px-3 py-2 text-sm text-gray-900 min-h-[200px] font-mono"
              value={editedAction.body || ""}
              onChange={(e) => setEditedAction({ ...editedAction, body: e.target.value })}
              rows={12}
            />
          ) : (
            <div className="text-sm text-gray-700 whitespace-pre-wrap bg-white/50 rounded p-3 leading-relaxed">
              {action.body}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProposedArchiveAction({ action }: { action: ParsedAction }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-gray-600 text-lg">&#128230;</span>
        <span className="text-base font-medium text-gray-900">Archive Email</span>
      </div>
      <div className="text-sm text-gray-600">
        Remove this thread from the inbox.
      </div>
      {action.thread_subject && (
        <div className="text-sm text-gray-700">
          Subject: <span className="font-medium">{action.thread_subject}</span>
        </div>
      )}
      <div className="text-xs text-gray-500 font-mono">
        {action.thread_id}
        <a
          href={`https://mail.google.com/mail/u/0/#inbox/${action.thread_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:text-blue-700 font-sans ml-2"
        >
          open in Gmail
        </a>
      </div>
    </div>
  );
}

function ProposedSlackAction({
  action,
  editing,
  editedAction,
  setEditedAction,
}: {
  action: ParsedAction;
  editing: boolean;
  editedAction: ParsedAction;
  setEditedAction: (a: ParsedAction) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-purple-700 text-lg">#</span>
        <span className="text-base font-medium text-gray-900">Send Slack Message</span>
      </div>
      <div>
        <label className="text-xs text-gray-500 block mb-1">Channel</label>
        <div className="text-sm text-gray-900 font-mono">{action.channel}</div>
      </div>
      {action.thread_ts && (
        <div>
          <label className="text-xs text-gray-500 block mb-1">Thread</label>
          <div className="text-sm text-gray-600 font-mono">{action.thread_ts}</div>
        </div>
      )}
      <div>
        <label className="text-xs text-gray-500 block mb-1">Message</label>
        {editing ? (
          <textarea
            className="w-full bg-gray-100 border border-gray-200 rounded px-3 py-2 text-sm text-gray-900 min-h-[120px]"
            value={editedAction.text || ""}
            onChange={(e) => setEditedAction({ ...editedAction, text: e.target.value })}
            rows={6}
          />
        ) : (
          <div className="text-sm text-gray-700 whitespace-pre-wrap bg-white/50 rounded p-3">
            {action.text}
          </div>
        )}
      </div>
    </div>
  );
}

function ProposedKnowledgeAction({ action }: { action: ParsedAction }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-emerald-700 text-lg">&#128218;</span>
        <span className="text-base font-medium text-gray-900">Knowledge Upsert</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
        <span className="text-gray-500">Type</span>
        <span className="text-gray-900">{action.type}</span>
        <span className="text-gray-500">Match On</span>
        <span className="text-gray-900">
          {Array.isArray(action.match_on) ? action.match_on.join(", ") : JSON.stringify(action.match_on ?? "")}
        </span>
        <span className="text-gray-500">Data</span>
        <pre className="text-gray-700 text-xs whitespace-pre-wrap bg-white/50 rounded p-2">
          {JSON.stringify(action.data, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// ---- Feedback / prompt improvement panel ----

type FeedbackState =
  | { step: "idle" }
  | { step: "asking"; type: "reject" | "edit" }
  | { step: "loading"; type: "reject" | "edit"; reason: string }
  | { step: "suggestion"; type: "reject" | "edit"; reason: string; suggestion: string; currentPrompt: string; workflowId: string }
  | { step: "applied" };

// Simple line-level diff between two strings
function computeLineDiff(oldText: string, newText: string): { type: "same" | "add" | "remove"; text: string }[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // LCS-based diff
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

  let i = m, j = n;
  const stack: { type: "same" | "add" | "remove"; text: string }[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "same", text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: "remove", text: oldLines[i - 1] });
      i--;
    }
  }
  stack.reverse();
  return stack;
}

function PromptDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = computeLineDiff(oldText.trim(), newText.trim());
  const hasChanges = lines.some(l => l.type !== "same");

  if (!hasChanges) {
    return <div className="text-xs text-gray-500 italic">No changes detected</div>;
  }

  return (
    <div className="bg-white rounded border border-gray-200 text-xs font-mono overflow-x-auto max-h-72 overflow-y-auto">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`px-3 py-0.5 whitespace-pre-wrap ${
            line.type === "add"
              ? "bg-green-950/60 text-green-600"
              : line.type === "remove"
                ? "bg-red-950/60 text-red-600"
                : "text-gray-600"
          }`}
        >
          <span className="inline-block w-4 text-gray-500 select-none mr-2">
            {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
          </span>
          {line.text || " "}
        </div>
      ))}
    </div>
  );
}

function FeedbackPanel({
  state,
  onSubmitReason,
  onApply,
  onSkip,
  onClose,
}: {
  state: FeedbackState;
  onSubmitReason: (reason: string) => void;
  onApply: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state.step === "asking") {
      setReason("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [state.step]);

  if (state.step === "idle") return null;

  return (
    <div className="border-t border-gray-200 bg-white/95 backdrop-blur p-4 shrink-0">
      {state.step === "asking" && (
        <div className="space-y-3">
          <div className="text-sm text-gray-700">
            {state.type === "reject"
              ? "Why are you rejecting this action?"
              : "What should be changed about this action?"}
          </div>
          <textarea
            ref={inputRef}
            className="w-full bg-gray-100 border border-gray-200 rounded px-3 py-2 text-sm text-gray-900 resize-none"
            rows={2}
            placeholder="e.g., should not contact venues that already declined..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && reason.trim()) {
                e.preventDefault();
                onSubmitReason(reason.trim());
              }
            }}
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={onSkip}
              className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 transition"
            >
              Skip
            </button>
            <button
              onClick={() => reason.trim() && onSubmitReason(reason.trim())}
              disabled={!reason.trim()}
              className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white px-4 py-1.5 rounded transition"
            >
              Suggest prompt change
            </button>
          </div>
        </div>
      )}

      {state.step === "loading" && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-600">Generating prompt improvement...</span>
          </div>
          <button
            onClick={onSkip}
            className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 transition"
          >
            Skip
          </button>
        </div>
      )}

      {state.step === "suggestion" && (
        <div className="space-y-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Suggested prompt change</div>
          <PromptDiff oldText={state.currentPrompt} newText={state.suggestion} />
          <div className="flex gap-2 justify-end">
            <button
              onClick={onSkip}
              className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 transition"
            >
              Discard
            </button>
            <button
              onClick={onApply}
              className="text-xs bg-green-700 hover:bg-green-600 text-white px-4 py-1.5 rounded transition"
            >
              Apply to workflow
            </button>
          </div>
        </div>
      )}

      {state.step === "applied" && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-green-700">Prompt updated!</span>
          <button
            onClick={onClose}
            className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 transition"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Main detail view ----

export default function ApprovalDetailView({
  items,
  onUpdate,
  onBack,
}: {
  items: ExecutionItem[];
  onUpdate: () => void;
  onBack: () => void;
}) {
  const flatActionsOriginal = flattenItems(items);
  const [reversed, setReversed] = useState(false);
  type ActionFilter = "all" | "email" | "archive" | "knowledge";
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const EMAIL_ACTIONS = ["reply_email", "send_email", "forward_email", "reply_all_email"];
  const filteredActions = actionFilter === "all" ? flatActionsOriginal
    : actionFilter === "email" ? flatActionsOriginal.filter(fa => EMAIL_ACTIONS.includes(fa.action.action))
    : actionFilter === "archive" ? flatActionsOriginal.filter(fa => fa.action.action === "archive_email")
    : flatActionsOriginal.filter(fa => fa.action.action === "knowledge_upsert");
  const flatActions = reversed ? [...filteredActions].reverse() : filteredActions;
  // Count per bucket for labels
  const emailCount = flatActionsOriginal.filter(fa => EMAIL_ACTIONS.includes(fa.action.action)).length;
  const archiveCount = flatActionsOriginal.filter(fa => fa.action.action === "archive_email").length;
  const knowledgeCount = flatActionsOriginal.filter(fa => fa.action.action === "knowledge_upsert").length;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [acting, setActing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedAction, setEditedAction] = useState<ParsedAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({ step: "idle" });
  const feedbackSkippedRef = useRef(false);

  // Clamp index when list shrinks (e.g. after approving/rejecting)
  const clampedIndex = Math.min(currentIndex, Math.max(0, flatActions.length - 1));
  if (clampedIndex !== currentIndex) {
    setCurrentIndex(clampedIndex);
  }
  const current = flatActions[clampedIndex];

  // Keyboard navigation
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === "ArrowLeft" || e.key === "k") {
        setCurrentIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight" || e.key === "j") {
        setCurrentIndex((i) => Math.min(flatActions.length - 1, i + 1));
      }
    },
    [flatActions.length, editing],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  // Reset edit/feedback state on navigation
  useEffect(() => {
    setEditing(false);
    setEditedAction(null);
    setFeedback({ step: "idle" });
  }, [clampedIndex]);

  if (flatActions.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">No actionable items to review</p>
        <button onClick={onBack} className="text-blue-700 hover:text-blue-600 text-sm mt-2">
          Back to list view
        </button>
      </div>
    );
  }

  const status = (current.action as any)._status as string | undefined;
  const isEditable = !status || status === "failed";
  const isApprovable = current.action.action !== "none" && !["executed", "queued", "rejected"].includes(status || "");

  const handleApprove = async () => {
    setActing(true);
    try {
      await approveItem(current.item.id, [current.actionIndex]);
      onUpdate();
      // Don't advance index — the approved action disappears from the list,
      // so the same index naturally points to the next action after refresh.
    } finally {
      setActing(false);
    }
  };

  const handleApproveAll = async () => {
    setActing(true);
    try {
      await approveItem(current.item.id);
      onUpdate();
    } finally {
      setActing(false);
    }
  };

  const [bulkBatches, setBulkBatches] = useState<Record<string, { total: number; done: number }>>({});
  const [showBulkModal, setShowBulkModal] = useState(false);

  const handleBulkApprove = async (filter: ActionFilter) => {
    const source = filter === "all" ? flatActionsOriginal
      : filter === "email" ? flatActionsOriginal.filter(fa => EMAIL_ACTIONS.includes(fa.action.action))
      : filter === "archive" ? flatActionsOriginal.filter(fa => fa.action.action === "archive_email")
      : flatActionsOriginal.filter(fa => fa.action.action === "knowledge_upsert");
    const toApprove = source.map(fa => ({ itemId: fa.item.id, actionIndex: fa.actionIndex }));
    if (toApprove.length === 0) return;
    setShowBulkModal(false);
    const batchKey = filter + "_" + Date.now();
    setBulkBatches(prev => ({ ...prev, [batchKey]: { total: toApprove.length, done: 0 } }));
    for (let i = 0; i < toApprove.length; i++) {
      try {
        await approveItem(toApprove[i].itemId, [toApprove[i].actionIndex]);
      } catch (err) {
        console.error("Bulk approve error:", err);
      }
      setBulkBatches(prev => ({ ...prev, [batchKey]: { total: toApprove.length, done: i + 1 } }));
      if (i < toApprove.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    setBulkBatches(prev => { const { [batchKey]: _, ...rest } = prev; return rest; });
    onUpdate();
  };

  const handleReject = async () => {
    // Show feedback panel instead of rejecting immediately
    setFeedback({ step: "asking", type: "reject" });
  };

  const handleRejectConfirm = async () => {
    setActing(true);
    try {
      await rejectItem(current.item.id, current.actionIndex);
      onUpdate();
    } finally {
      setActing(false);
    }
  };

  const handleStartEdit = () => {
    setEditing(true);
    setEditedAction({ ...current.action });
  };

  const handleSaveEdit = async () => {
    if (!editedAction) return;
    setSaving(true);
    try {
      await updateApprovalAction(current.item.id, current.actionIndex, editedAction);
      setEditing(false);
      onUpdate();
      // Ask for feedback on what was changed
      setFeedback({ step: "asking", type: "edit" });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditedAction(null);
  };

  const handleFeedbackSubmit = async (reason: string) => {
    const type = feedback.step === "asking" ? (feedback as any).type : "reject";
    setFeedback({ step: "loading", type, reason });
    feedbackSkippedRef.current = false;

    // If rejecting, do the actual rejection now
    if (type === "reject") {
      await handleRejectConfirm();
    }

    try {
      const result = await suggestPromptChange({
        itemId: current.item.id,
        actionIndex: current.actionIndex,
        reason,
        type,
      });
      if (feedbackSkippedRef.current) return;
      setFeedback({
        step: "suggestion",
        type,
        reason,
        suggestion: result.suggestion,
        currentPrompt: result.currentPrompt,
        workflowId: result.workflowId,
      });
    } catch (err) {
      console.error("Failed to get suggestion:", err);
      setFeedback({ step: "idle" });
    }
  };

  const handleFeedbackApply = async () => {
    if (feedback.step !== "suggestion") return;
    try {
      await updateWorkflow(feedback.workflowId, {
        action_prompt: feedback.suggestion,
      });
      setFeedback({ step: "applied" });
    } catch (err) {
      console.error("Failed to apply prompt change:", err);
    }
  };

  const handleFeedbackSkip = () => {
    feedbackSkippedRef.current = true;
    const type = (feedback as any).type;
    // If we were asking for reject feedback and user skips, still reject
    if (feedback.step === "asking" && type === "reject") {
      handleRejectConfirm();
    }
    setFeedback({ step: "idle" });
  };

  // Count actions for same item
  const sameItemActions = flatActions.filter((fa) => fa.item.id === current.item.id);
  const pendingInItem = sameItemActions.filter(
    (fa) => (fa.action as any)._status !== "executed" && (fa.action as any)._status !== "queued",
  );

  // Determine context panel
  const threadId = current.action.thread_id || current.item.item_data?.threadId;
  const isEmail = ["reply_email", "send_email", "forward_email", "archive_email"].includes(current.action.action);
  const isSlack = current.action.action === "send_slack";
  const hasEmailContext = !!(threadId || current.item.item_data?.threadId);


  // Thread conflict detection — check backend-stamped flag + client-side scan
  const hasServerConflict = !!(current.action as any)._thread_conflict;
  const clientConflicts = threadId
    ? flatActions.filter(
        (fa, i) =>
          i !== currentIndex &&
          fa.item.id !== current.item.id &&
          fa.action.thread_id === threadId &&
          !["archive_email", "none"].includes(fa.action.action),
      )
    : [];
  const hasConflict = hasServerConflict || clientConflicts.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white/80 shrink-0 sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-gray-600 hover:text-gray-900 transition text-sm"
          >
            &larr; List
          </button>
          <div className="text-sm text-gray-600">
            <span className="text-gray-900 font-medium">{currentIndex + 1}</span>
            <span className="mx-1">/</span>
            <span>{flatActions.length}</span>
            <span className="ml-3 text-gray-500">{formatDate(current.item.created_at)}</span>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              className="text-gray-600 hover:text-gray-900 disabled:opacity-30 px-2 py-1 rounded hover:bg-gray-100 transition"
            >
              &larr;
            </button>
            <button
              onClick={() => setCurrentIndex((i) => Math.min(flatActions.length - 1, i + 1))}
              disabled={currentIndex === flatActions.length - 1}
              className="text-gray-600 hover:text-gray-900 disabled:opacity-30 px-2 py-1 rounded hover:bg-gray-100 transition"
            >
              &rarr;
            </button>
          </div>
          <button
            onClick={() => { setReversed((r) => !r); setCurrentIndex(0); }}
            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition"
            title={reversed ? "Showing newest first" : "Showing oldest first"}
          >
            {reversed ? "Newest first" : "Oldest first"}
          </button>
          <span className="text-gray-700 mx-1">|</span>
          {([
            ["all", "All", flatActionsOriginal.length],
            ["email", "Emails", emailCount],
            ["archive", "Archives", archiveCount],
            ["knowledge", "Knowledge", knowledgeCount],
          ] as [ActionFilter, string, number][]).map(([key, label, count]) => (
            count > 0 && <button
              key={key}
              onClick={() => { setActionFilter(key); setCurrentIndex(0); }}
              className={`text-xs px-2 py-1 rounded transition ${
                actionFilter === key
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
              }`}
            >
              {label} ({count})
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {Object.entries(bulkBatches).map(([key, b]) => (
            <span key={key} className="text-xs text-green-700">
              Approving {b.done}/{b.total}...
            </span>
          ))}
          {flatActions.length > 1 && (
            <button
              onClick={() => setShowBulkModal(true)}
              className="text-xs bg-green-100/40 hover:bg-green-100/50 text-green-600 px-3 py-1.5 rounded transition"
            >
              Approve All {actionFilter !== "all" ? `${actionFilter} ` : ""}({flatActions.length})...
            </button>
          )}
          {status === "executed" && <span className="text-green-700 text-sm">Done</span>}
          {status === "queued" && <span className="text-yellow-700 text-sm">Queued</span>}
          {status === "failed" && <span className="text-red-700 text-sm">Failed</span>}

          {isEditable && !editing && (
            <button
              onClick={handleStartEdit}
              className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded border border-gray-200 hover:border-gray-300 transition"
            >
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={handleCancelEdit}
                className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white px-3 py-1.5 rounded transition"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          )}
          {isApprovable && !editing && (
            <>
              <button
                onClick={handleReject}
                disabled={acting}
                className="text-xs bg-red-100/50 hover:bg-red-100/50 disabled:opacity-50 text-red-600 px-3 py-1.5 rounded transition"
              >
                Reject
              </button>
              {pendingInItem.length > 1 && (
                <button
                  onClick={handleApproveAll}
                  disabled={acting}
                  className="text-xs bg-green-100/50 hover:bg-green-100/50 disabled:opacity-50 text-green-600 px-3 py-1.5 rounded transition"
                >
                  Approve All ({pendingInItem.length})
                </button>
              )}
              <button
                onClick={handleApprove}
                disabled={acting}
                className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm px-5 py-1.5 rounded-md transition font-medium"
              >
                {acting ? "Approving..." : "Approve"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Thread conflict warning */}
      {hasConflict && (
        <div className="px-5 py-2 bg-yellow-100/30 border-b border-yellow-800/50 shrink-0">
          <div className="flex items-center gap-2 text-sm text-yellow-700">
            <span>&#9888;</span>
            <span>Another action in this batch also targets this thread</span>
          </div>
          {clientConflicts.length > 0 && (
            <div className="text-xs text-yellow-700/70 mt-1">
              {clientConflicts.map((fa, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {fa.action.action} (item {flatActions.indexOf(fa) + 1})
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main content - split view */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel — context */}
        <div className="w-1/2 border-r border-gray-200 overflow-y-auto">
          {(isEmail || hasEmailContext) && threadId ? (
            <GmailThreadPanel threadId={threadId} />
          ) : isSlack ? (
            <SlackThreadPanel
              channelId={current.action.channel}
              threadTs={current.action.thread_ts}
            />
          ) : (
            <div className="p-4">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">Item Data</div>
              <ItemDataCard data={current.item.item_data} />
            </div>
          )}
        </div>

        {/* Right panel — proposed action */}
        <div className="w-1/2 overflow-y-auto p-5">
          {/* Item context badge */}
          <div className="mb-4 pb-3 border-b border-gray-200">
            <details>
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
                Item context
                {sameItemActions.length > 1 && (
                  <span className="ml-2 text-gray-500">
                    (action {sameItemActions.indexOf(current) + 1} of {sameItemActions.length})
                  </span>
                )}
              </summary>
              <div className="mt-2">
                <ItemDataCard data={current.item.item_data} />
              </div>
            </details>
          </div>

          {/* The proposed action */}
          {(current.action.action === "reply_email" ||
            current.action.action === "send_email" ||
            current.action.action === "forward_email") && (
            <ProposedEmailAction
              action={current.action}
              editing={editing}
              editedAction={editedAction || current.action}
              setEditedAction={setEditedAction}
            />
          )}
          {current.action.action === "archive_email" && (
            <ProposedArchiveAction action={current.action} />
          )}
          {current.action.action === "send_slack" && (
            <ProposedSlackAction
              action={current.action}
              editing={editing}
              editedAction={editedAction || current.action}
              setEditedAction={setEditedAction}
            />
          )}
          {current.action.action === "knowledge_upsert" && (
            <ProposedKnowledgeAction action={current.action} />
          )}
          {current.action.action === "custom" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-amber-700 text-lg">&#9998;</span>
                <span className="text-base font-medium text-gray-900">Manual Action</span>
              </div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">
                {current.action.description}
              </div>
            </div>
          )}

          {/* Agent reasoning */}
          {current.item.agent_result && (
            <details className="mt-6">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
                Agent reasoning
              </summary>
              <div className="mt-2 text-sm text-gray-600 whitespace-pre-wrap bg-white/50 rounded p-3 max-h-60 overflow-y-auto">
                {current.item.agent_actions?.length
                  ? current.item.agent_result
                  : parseAgentResult(current.item.agent_result).summary}
              </div>
            </details>
          )}

          {/* Agent trace (tool calls, thinking steps) */}
          {current.item.agent_steps && current.item.agent_steps.length > 0 && (
            <details className="mt-3">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
                Agent trace ({current.item.agent_steps.length} steps)
              </summary>
              <div className="mt-2 bg-white/50 rounded p-3 space-y-1 max-h-60 overflow-y-auto">
                {current.item.agent_steps.map((step, j) => (
                  <div key={j} className="text-xs flex gap-2">
                    {step.type === "tool_call" && (
                      <>
                        <span className="text-green-700 shrink-0">&#10003;</span>
                        <span className="text-gray-600">{step.data}</span>
                      </>
                    )}
                    {step.type === "thinking" && (
                      <>
                        <span className="text-purple-700 shrink-0">&#9679;</span>
                        <span className="text-gray-500 whitespace-pre-wrap">{step.data}</span>
                      </>
                    )}
                    {step.type === "text" && (
                      <>
                        <span className="text-blue-700 shrink-0">&#9654;</span>
                        <span className="text-gray-700 whitespace-pre-wrap">{step.data}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>

      {/* Feedback / prompt improvement panel */}
      <FeedbackPanel
        state={feedback}
        onSubmitReason={handleFeedbackSubmit}
        onApply={handleFeedbackApply}
        onSkip={handleFeedbackSkip}
        onClose={() => setFeedback({ step: "idle" })}
      />

      {/* Bulk approve modal */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowBulkModal(false)}>
          <div className="bg-gray-100 rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Bulk Approve</h3>
            <p className="text-gray-600 text-sm mb-4">Choose which actions to approve. They'll be processed in the background, spaced 1 second apart.</p>
            <div className="flex flex-col gap-2 mb-5">
              {([
                ["all", "All actions", flatActionsOriginal.length],
                ["email", "Emails (send/reply/forward)", emailCount],
                ["archive", "Archives", archiveCount],
                ["knowledge", "Knowledge upserts", knowledgeCount],
              ] as [ActionFilter, string, number][]).map(([key, label, count]) => (
                count > 0 && <button
                  key={key}
                  onClick={() => handleBulkApprove(key)}
                  className="flex justify-between items-center px-4 py-2.5 text-sm bg-gray-200 hover:bg-green-100/50 hover:text-green-600 text-gray-900 rounded transition text-left"
                >
                  <span>{label}</span>
                  <span className="text-gray-600 text-xs">{count} actions</span>
                </button>
              ))}
            </div>
            <button onClick={() => setShowBulkModal(false)}
              className="w-full px-4 py-2 text-sm bg-gray-200 hover:bg-gray-300 text-gray-700 rounded transition">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
