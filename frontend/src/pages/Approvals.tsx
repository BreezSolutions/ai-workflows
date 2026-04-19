import { useEffect, useState } from "react";
import { listPendingApprovals, approveItem, rejectItem, clearAllApprovals, listWorkflows, type ExecutionItem, type Workflow } from "../api";
import { parseAgentResult, ItemDataCard, ActionCard } from "../components/AgentResultCard";
import ApprovalDetailView from "../components/ApprovalDetailView";
import ReactMarkdown from "react-markdown";

function isNoAction(item: ExecutionItem): boolean {
  if (item.agent_actions?.length) {
    return item.agent_actions.every((a) => a.action === "none");
  }
  if (item.agent_result) {
    const parsed = parseAgentResult(item.agent_result);
    return parsed.actions.length > 0 && parsed.actions.every((a) => a.action === "none");
  }
  return false;
}

export default function Approvals() {
  const [items, setItems] = useState<ExecutionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [showNoAction, setShowNoAction] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearWorkflowId, setClearWorkflowId] = useState<string>("");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>("");
  const [viewMode, setViewMode] = useState<"list" | "detail">("list");

  const load = () => {
    listPendingApprovals(selectedWorkflow || undefined)
      .then(setItems)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    listWorkflows().then(setWorkflows);
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [selectedWorkflow]);

  const approve = async (item: ExecutionItem) => {
    setActing((prev) => new Set(prev).add(item.id));
    try {
      await approveItem(item.id);
      load();
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const reject = async (item: ExecutionItem) => {
    setActing((prev) => new Set(prev).add(item.id));
    try {
      await rejectItem(item.id);
      load();
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  if (loading) return <p className="text-gray-500">Loading...</p>;

  if (items.length === 0)
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">No pending approvals</p>
      </div>
    );

  if (viewMode === "detail") {
    return (
      <div className="fixed inset-0 top-14 z-40 bg-white">
        <ApprovalDetailView
          items={items}
          onUpdate={load}
          onBack={() => setViewMode("list")}
        />
      </div>
    );
  }

  const noActionCount = items.filter(isNoAction).length;
  const visibleItems = showNoAction ? items : items.filter((item) => !isNoAction(item));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Pending Approvals</h1>
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
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode("detail")}
            className="text-xs text-blue-700 hover:text-blue-600 px-3 py-1 rounded border border-blue-800 hover:border-blue-200 transition"
          >
            Detail view
          </button>
          {noActionCount > 0 && (
            <button
              onClick={() => setShowNoAction((prev) => !prev)}
              className="text-xs text-gray-500 hover:text-gray-700 transition"
            >
              {showNoAction ? "Hide" : "Show"} no-action items ({noActionCount})
            </button>
          )}
          <button
            onClick={() => setShowClearConfirm(true)}
            className="text-xs text-red-500 hover:text-red-700 transition"
          >
            Clear all
          </button>
        </div>
      </div>

      {showClearConfirm && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-600">
              Clear pending approvals for:
            </p>
            <select
              value={clearWorkflowId}
              onChange={(e) => setClearWorkflowId(e.target.value)}
              className="bg-gray-100 border border-gray-200 text-gray-700 text-sm rounded-md px-2 py-1"
            >
              <option value="">All workflows</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setShowClearConfirm(false); setClearWorkflowId(""); }}
              className="text-xs text-gray-600 hover:text-gray-700 px-3 py-1.5 transition"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                setClearing(true);
                try {
                  await clearAllApprovals(clearWorkflowId || undefined);
                  setShowClearConfirm(false);
                  setClearWorkflowId("");
                  load();
                } finally {
                  setClearing(false);
                }
              }}
              disabled={clearing}
              className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs px-4 py-1.5 rounded-md transition"
            >
              {clearing ? "Clearing..." : `Yes, delete${clearWorkflowId ? "" : " all"}`}
            </button>
          </div>
        </div>
      )}

      {visibleItems.length === 0 && (
        <div className="text-center py-10">
          <p className="text-gray-500 text-sm">
            {noActionCount} no-action item{noActionCount !== 1 ? "s" : ""} hidden
          </p>
        </div>
      )}

      {visibleItems.map((item) => {
        const isActing = acting.has(item.id);

        return (
          <div
            key={item.id}
            className="bg-white border border-gray-200 rounded-lg p-5 space-y-4"
          >
            {/* Item data (open by default) */}
            <details className="group" open>
              <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-600 transition">
                Item data
              </summary>
              <ItemDataCard data={item.item_data} />
            </details>

            {/* Agent steps (collapsed) */}
            {item.agent_steps && item.agent_steps.length > 0 && (
              <details className="group">
                <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-600 transition">
                  Agent trace ({item.agent_steps.length} steps)
                </summary>
                <div className="mt-2 bg-white rounded p-3 space-y-1 max-h-[32rem] overflow-y-auto">
                  {item.agent_steps.map((step, j) => (
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

            {/* Agent result with per-action approve buttons */}
            {(() => {
              // Prefer pre-staged actions from DB, fall back to parsing agent_result text
              const actions = (item.agent_actions && item.agent_actions.length > 0)
                ? item.agent_actions
                : (item.agent_result ? parseAgentResult(item.agent_result).actions : []);
              const summary = item.agent_result
                ? (item.agent_actions?.length ? item.agent_result : parseAgentResult(item.agent_result).summary)
                : "";
              return (
                <div className="space-y-3">
                  {summary && (
                    <div className="text-sm text-gray-700 prose prose-sm max-w-none">
                      <ReactMarkdown>{summary}</ReactMarkdown>
                    </div>
                  )}

                  {actions.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs text-gray-500 uppercase tracking-wide">
                        {actions.length === 1 ? "Action" : `${actions.length} Actions`}
                      </div>
                      {actions.map((action, i) => {
                        const status = (action as any)._status as string | undefined;
                        const result = (action as any)._result as string | undefined;
                        return (
                          <div key={i} className={status === "executed" ? "opacity-50" : status === "queued" ? "opacity-70" : ""}>
                            <div className="flex items-center gap-2">
                              {status === "executed" && <span className="text-green-700 text-xs">&#10003; Done</span>}
                              {status === "queued" && <span className="text-yellow-700 text-xs">&#9679; Queued</span>}
                              {status === "failed" && <span className="text-red-700 text-xs">&#10007; Failed: {result}</span>}
                              {(action as any)._thread_conflict && <span className="text-yellow-700 text-xs">&#9888; Thread conflict</span>}
                            </div>
                            <ActionCard action={action} />
                            {action.action !== "none" && status !== "executed" && status !== "queued" && (
                              <div className="flex gap-2 mt-1.5 ml-1">
                                <button
                                  onClick={() => approveItem(item.id, [i]).then(load)}
                                  disabled={isActing}
                                  className="text-xs bg-green-100/50 hover:bg-green-700/50 disabled:opacity-50 text-green-600 px-3 py-1 rounded transition"
                                >
                                  {status === "failed" ? "Retry" : "Approve"}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Approve all / Reject buttons */}
                  <div className="flex gap-2 pt-1">
                    {actions.some((a: any) => a.action !== "none" && (a as any)._status !== "executed" && (a as any)._status !== "queued") && (
                      <button
                        onClick={() => approve(item)}
                        disabled={isActing}
                        className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-md transition"
                      >
                        {isActing ? "Approving..." : "Approve All"}
                      </button>
                    )}
                    <button
                      onClick={() => reject(item)}
                      disabled={isActing}
                      className="bg-red-100 hover:bg-red-700 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-md transition"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}
