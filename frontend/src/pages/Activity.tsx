import { useEffect, useState } from "react";
import { listCompletedItems, listWorkflows, type ExecutionItem, type Workflow } from "../api";
import { ItemDataCard, ActionCard, AgentResultDisplay } from "../components/AgentResultCard";

const ACTION_BADGES: Record<string, { text: string; color: string }> = {
  send_email: { text: "Email Sent", color: "bg-blue-500" },
  reply_email: { text: "Email Replied", color: "bg-blue-500" },
  send_slack: { text: "Slack Sent", color: "bg-purple-500" },
  none: { text: "No Action", color: "bg-gray-500" },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function isNoAction(item: ExecutionItem): boolean {
  if (item.agent_actions?.length) {
    return item.agent_actions.every((a) => a.action === "none");
  }
  return false;
}

export default function Activity() {
  const [items, setItems] = useState<ExecutionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNoAction, setShowNoAction] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>("");

  useEffect(() => {
    listWorkflows().then(setWorkflows);
  }, []);

  useEffect(() => {
    setLoading(true);
    listCompletedItems(selectedWorkflow || undefined)
      .then(setItems)
      .finally(() => setLoading(false));
  }, [selectedWorkflow]);

  if (loading) return <p className="text-gray-500">Loading...</p>;

  if (items.length === 0)
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">No completed actions yet</p>
        <p className="text-gray-500 text-sm mt-1">
          Run a workflow to see results here
        </p>
      </div>
    );

  const noActionCount = items.filter(isNoAction).length;
  const visibleItems = showNoAction ? items : items.filter((item) => !isNoAction(item));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Activity</h1>
          <select
            value={selectedWorkflow}
            onChange={(e) => setSelectedWorkflow(e.target.value)}
            className="bg-gray-100 border border-gray-200 text-gray-700 text-sm rounded-md px-2 py-1"
          >
            <option value="">All workflows</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        {noActionCount > 0 && (
          <button
            onClick={() => setShowNoAction((prev) => !prev)}
            className="text-xs text-gray-500 hover:text-gray-700 transition"
          >
            {showNoAction ? "Hide" : "Show"} no-action items ({noActionCount})
          </button>
        )}
      </div>

      {visibleItems.length === 0 && (
        <div className="text-center py-10">
          <p className="text-gray-500 text-sm">
            {noActionCount} no-action item{noActionCount !== 1 ? "s" : ""} hidden
          </p>
        </div>
      )}

      {visibleItems.map((item) => {
        const primaryAction = item.agent_actions?.[0]?.action;
        const badge = primaryAction
          ? (ACTION_BADGES[primaryAction] ?? { text: primaryAction, color: "bg-gray-500" })
          : { text: item.status === "approved" ? "Approved" : "Completed", color: "bg-gray-500" };
        return (
          <div
            key={item.id}
            className="bg-white border border-gray-200 rounded-lg p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${badge.color}`} />
                <span className="text-xs text-gray-600">{badge.text}</span>
              </div>
              <span className="text-xs text-gray-500">
                {item.completed_at ? timeAgo(item.completed_at) : ""}
              </span>
            </div>

            <details className="group" open>
              <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-600 transition">
                Item data
              </summary>
              <ItemDataCard data={item.item_data} />
            </details>

            {/* Structured action cards from stored actions */}
            {item.agent_actions && item.agent_actions.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-gray-500 uppercase tracking-wide">
                  {item.agent_actions.length === 1 ? "Action" : `${item.agent_actions.length} Actions`}
                </div>
                {item.agent_actions.map((action, i) => (
                  <ActionCard key={i} action={action} />
                ))}
              </div>
            )}

            {/* Agent analysis text */}
            {item.agent_result && (
              <details className="group">
                <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-600 transition">
                  Agent analysis
                </summary>
                <div className="mt-2">
                  <AgentResultDisplay agentResult={item.agent_result} />
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
