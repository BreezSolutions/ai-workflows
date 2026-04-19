import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getWorkflow, listRuns, listItems, triggerWorkflow, testWorkflow, testWorkflowWithTrigger, abortRun, fetchTestItems, fetchThreadPreview, listSlackChannels, listSlackMessages, listSlackThread, type Workflow, type ExecutionRun, type ExecutionItem, type RunLog, type SlackChannel, type SlackMessage } from "../api";
import { ItemDataCard, ActionCard, AgentResultDisplay } from "../components/AgentResultCard";

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-500",
  completed: "bg-green-500",
  failed: "bg-red-500",
  aborted: "bg-orange-500",
  pending: "bg-gray-500",
  awaiting_approval: "bg-amber-500",
  approved: "bg-green-500",
  rejected: "bg-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
  pending: "Pending",
  awaiting_approval: "Awaiting Approval",
  approved: "Approved",
  rejected: "Rejected",
};

const LOG_ICONS: Record<string, string> = {
  info: "\u2139\uFE0F",
  warn: "\u26A0\uFE0F",
  error: "\u274C",
};

const LOG_COLORS: Record<string, string> = {
  info: "text-gray-600",
  warn: "text-amber-700",
  error: "text-red-700",
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function duration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function LogTimeline({ logs }: { logs: RunLog[] }) {
  if (!logs || logs.length === 0) return null;

  return (
    <div className="space-y-0">
      {logs.map((log, i) => (
        <div key={i} className="flex items-start gap-3 py-1.5 px-4">
          <div className="flex flex-col items-center shrink-0">
            <span className="text-xs">{LOG_ICONS[log.level]}</span>
            {i < logs.length - 1 && (
              <div className="w-px h-full bg-gray-100 min-h-[8px]" />
            )}
          </div>
          <span className="text-xs text-gray-500 shrink-0 font-mono w-16">
            {formatTime(log.ts)}
          </span>
          <span className={`text-xs ${LOG_COLORS[log.level]}`}>
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function WorkflowDetail() {
  const { id } = useParams<{ id: string }>();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<Record<string, "logs" | "items">>({});
  const [items, setItems] = useState<Record<string, ExecutionItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [showTestPicker, setShowTestPicker] = useState(false);
  const [testItems, setTestItems] = useState<Record<string, any>[]>([]);
  const [testItemsLoading, setTestItemsLoading] = useState(false);
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<Record<string, Record<string, any>[]>>({});
  const [threadLoading, setThreadLoading] = useState<string | null>(null);

  // Slack message picker state (for trigger-based workflows)
  const [showSlackPicker, setShowSlackPicker] = useState(false);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackPickerChannel, setSlackPickerChannel] = useState<string | null>(null);
  const [slackMessages, setSlackMessages] = useState<SlackMessage[]>([]);
  const [slackMessagesLoading, setSlackMessagesLoading] = useState(false);
  const [slackThreadView, setSlackThreadView] = useState<string | null>(null);
  const [slackThreadReplies, setSlackThreadReplies] = useState<SlackMessage[]>([]);
  const [slackThreadLoading, setSlackThreadLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getWorkflow(id), listRuns(id)]).then(([w, r]) => {
      setWorkflow(w);
      setRuns(r);
      setLoading(false);
    });
  }, [id]);

  const toggleRun = async (runId: string) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
      return;
    }
    if (!items[runId]) {
      const runItems = await listItems(runId);
      setItems((prev) => ({ ...prev, [runId]: runItems }));
    }
    setExpandedRun(runId);
    setExpandedSection((prev) => ({ ...prev, [runId]: prev[runId] ?? "logs" }));
  };

  const trigger = async () => {
    if (!id) return;
    const limit = runLimit ? parseInt(runLimit) : undefined;
    await triggerWorkflow(id, limit);
    const r = await listRuns(id);
    setRuns(r);
  };

  const openTestPicker = async () => {
    if (!id) return;
    setShowTestPicker(true);
    setTestItemsLoading(true);
    try {
      const items = await fetchTestItems(id);
      setTestItems(items);
    } catch (err) {
      console.error("Failed to fetch test items:", err);
    } finally {
      setTestItemsLoading(false);
    }
  };

  const toggleThread = async (threadId: string) => {
    if (expandedThread === threadId) {
      setExpandedThread(null);
      return;
    }
    setExpandedThread(threadId);
    if (!threadMessages[threadId]) {
      setThreadLoading(threadId);
      try {
        const msgs = await fetchThreadPreview(id!, threadId);
        setThreadMessages((prev) => ({ ...prev, [threadId]: msgs }));
      } catch (err) {
        console.error("Failed to fetch thread:", err);
      } finally {
        setThreadLoading(null);
      }
    }
  };

  const runTestOnItem = async (item: Record<string, any>) => {
    if (!id) return;
    setShowTestPicker(false);
    // Ensure we have full message data (from/to/subject/body) for the agent
    const threadId = item.threadId;
    let enriched = item;
    if (threadId) {
      let cached = threadMessages[threadId];
      if (!cached) {
        try {
          cached = await fetchThreadPreview(id, threadId);
          setThreadMessages((prev) => ({ ...prev, [threadId]: cached }));
        } catch {}
      }
      if (cached?.[0]) enriched = { ...cached[0] };
    }
    await testWorkflow(id, enriched);
    const r = await listRuns(id);
    setRuns(r);
  };

  const openSlackPicker = async () => {
    setShowSlackPicker(true);
    setSlackPickerChannel(null);
    setSlackMessages([]);
    setSlackThreadView(null);
    if (slackChannels.length === 0) {
      const channels = await listSlackChannels();
      setSlackChannels(channels);
    }
  };

  const pickSlackChannel = async (channelId: string) => {
    setSlackPickerChannel(channelId);
    setSlackMessagesLoading(true);
    setSlackThreadView(null);
    try {
      const msgs = await listSlackMessages(channelId);
      setSlackMessages(msgs);
    } catch { setSlackMessages([]); }
    finally { setSlackMessagesLoading(false); }
  };

  const viewSlackThread = async (threadTs: string) => {
    if (!slackPickerChannel) return;
    setSlackThreadView(threadTs);
    setSlackThreadLoading(true);
    try {
      const replies = await listSlackThread(slackPickerChannel, threadTs);
      setSlackThreadReplies(replies);
    } catch { setSlackThreadReplies([]); }
    finally { setSlackThreadLoading(false); }
  };

  const runTestOnSlackMessage = async (msg: SlackMessage) => {
    if (!id || !slackPickerChannel) return;
    setShowSlackPicker(false);
    const triggerData = {
      trigger: "slack_message",
      channel: slackPickerChannel,
      user: msg.user,
      text: msg.text,
      ts: msg.ts,
      thread_ts: msg.thread_ts,
    };
    await testWorkflowWithTrigger(id, triggerData);
    const r = await listRuns(id);
    setRuns(r);
  };

  const [runLimit, setRunLimit] = useState<string>("");
  const [randomCount, setRandomCount] = useState(1);

  const runTestRandom = async (count: number = 1) => {
    if (!id) return;
    setShowTestPicker(false);
    await testWorkflow(id, undefined, count);
    const r = await listRuns(id);
    setRuns(r);
  };

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!workflow) return <p className="text-gray-500">Workflow not found</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-700 transition">
            &larr; Back
          </Link>
          <h1 className="text-xl font-semibold text-gray-900 mt-1">{workflow.name}</h1>
          <div className="flex gap-3 mt-1 text-sm text-gray-500">
            <span>Trigger: {workflow.trigger_type}</span>
            {workflow.list_source && <span>List: {workflow.list_source}</span>}
            <span>Mode: {workflow.action_mode}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {workflow.list_source ? (
            <button
              onClick={openTestPicker}
              className="bg-amber-600 hover:bg-amber-500 text-white text-sm px-4 py-1.5 rounded-md transition"
            >
              Test
            </button>
          ) : workflow.trigger_type === "slack_message" ? (
            <button
              onClick={openSlackPicker}
              className="bg-amber-600 hover:bg-amber-500 text-white text-sm px-4 py-1.5 rounded-md transition"
            >
              Test
            </button>
          ) : null}
          {["slack_message", "gmail_poll"].includes(workflow.trigger_type) ? (
            workflow.enabled && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-700 px-3 py-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Active — listening
              </span>
            )
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                placeholder="all"
                value={runLimit}
                onChange={(e) => setRunLimit(e.target.value)}
                className="w-14 bg-gray-100 border border-gray-200 text-gray-900 text-xs rounded px-1.5 py-1.5 text-center placeholder-gray-400"
                title="Limit to first N items"
              />
              <button
                onClick={trigger}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-1.5 rounded-md transition"
              >
                Run{runLimit ? ` first ${runLimit}` : ""}
              </button>
            </div>
          )}
          <Link
            to={`/workflows/${id}/edit`}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm px-4 py-1.5 rounded-md transition"
          >
            Edit
          </Link>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-gray-600 uppercase tracking-wider">
          Execution History
        </h2>
        {runs.length === 0 ? (
          <p className="text-gray-500 text-sm py-4">No runs yet</p>
        ) : (
          runs.map((run) => {
            const section = expandedSection[run.id] ?? "logs";
            return (
              <div key={run.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleRun(run.id)}
                  className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-gray-100/50 transition"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[run.status] ?? "bg-gray-500"}`} />
                  <span className="text-sm text-gray-900 flex items-center gap-2">
                    {run.triggered_by}
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      run.status === "completed" ? "bg-green-100/50 text-green-700" :
                      run.status === "failed" ? "bg-red-100/50 text-red-700" :
                      run.status === "aborted" ? "bg-orange-100/50 text-orange-700" :
                      "bg-blue-100/50 text-blue-700"
                    }`}>
                      {STATUS_LABELS[run.status] ?? run.status}
                    </span>
                    {run.status === "running" && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await abortRun(run.id);
                          const r = await listRuns(id!);
                          setRuns(r);
                        }}
                        className="text-xs px-2 py-0.5 rounded bg-red-100/50 text-red-700 hover:bg-red-100/50 transition"
                      >
                        Abort
                      </button>
                    )}
                  </span>
                  <span className="text-xs text-gray-500">
                    {run.items_completed}/{run.items_total} items
                  </span>
                  {run.cost_usd > 0 && (
                    <span className="text-xs text-emerald-500 font-mono">
                      ${run.cost_usd.toFixed(4)}
                    </span>
                  )}
                  <span className="text-xs text-gray-500">
                    {duration(run.started_at, run.completed_at)}
                  </span>
                  <span className="text-xs text-gray-500 ml-auto">{timeAgo(run.started_at)}</span>
                  <svg
                    className={`w-4 h-4 text-gray-500 transition-transform ${expandedRun === run.id ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {expandedRun === run.id && (
                  <div className="border-t border-gray-200">
                    {/* Tab bar */}
                    <div className="flex border-b border-gray-200">
                      <button
                        onClick={() => setExpandedSection((prev) => ({ ...prev, [run.id]: "logs" }))}
                        className={`px-4 py-2 text-xs font-medium transition ${
                          section === "logs"
                            ? "text-indigo-600 border-b-2 border-indigo-400"
                            : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        Logs {run.logs?.length ? `(${run.logs.length})` : ""}
                      </button>
                      <button
                        onClick={() => setExpandedSection((prev) => ({ ...prev, [run.id]: "items" }))}
                        className={`px-4 py-2 text-xs font-medium transition ${
                          section === "items"
                            ? "text-indigo-600 border-b-2 border-indigo-400"
                            : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        Items ({items[run.id]?.length ?? run.items_total})
                      </button>
                    </div>

                    {/* Logs tab */}
                    {section === "logs" && (
                      <div className="py-2">
                        {run.logs && run.logs.length > 0 ? (
                          <LogTimeline logs={run.logs} />
                        ) : (
                          <p className="px-5 py-3 text-sm text-gray-500">No logs yet</p>
                        )}
                      </div>
                    )}

                    {/* Items tab */}
                    {section === "items" && items[run.id] && (
                      <div className="divide-y divide-gray-200/50">
                        {items[run.id].length === 0 ? (
                          <p className="px-5 py-3 text-sm text-gray-500">No items</p>
                        ) : (
                          items[run.id].map((item, idx) => (
                            <div key={item.id} className="px-5 py-3 space-y-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[item.status] ?? "bg-gray-500"}`}
                                />
                                <span className="text-xs font-medium text-gray-700">
                                  Item {idx + 1}
                                </span>
                                <span className="text-xs text-gray-500">
                                  {STATUS_LABELS[item.status] ?? item.status}
                                </span>
                                {item.cost_usd > 0 && (
                                  <span className="text-xs text-emerald-500 font-mono">
                                    ${item.cost_usd.toFixed(4)}
                                  </span>
                                )}
                                {item.completed_at && (
                                  <span className="text-xs text-gray-500 ml-auto">
                                    {duration(item.created_at, item.completed_at)}
                                  </span>
                                )}
                              </div>
                              <details className="group" open>
                                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
                                  Input data
                                </summary>
                                <ItemDataCard data={item.item_data} />
                              </details>
                              {/* Agent trace */}
                              {item.agent_steps && item.agent_steps.length > 0 && (
                                <details className="group">
                                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
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
                              {item.agent_result && (
                                <details className="group">
                                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
                                    Agent analysis
                                  </summary>
                                  <div className="mt-1">
                                    <AgentResultDisplay agentResult={item.agent_result} />
                                  </div>
                                </details>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Slack Message Picker Modal (trigger-based test) */}
      {showSlackPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white border border-gray-200 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {slackThreadView ? "Pick a message from thread" : slackPickerChannel ? "Pick a message to test" : "Pick a channel"}
              </h2>
              <div className="flex items-center gap-2">
                {(slackThreadView || slackPickerChannel) && (
                  <button
                    onClick={() => {
                      if (slackThreadView) setSlackThreadView(null);
                      else setSlackPickerChannel(null);
                    }}
                    className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-md bg-gray-100 hover:bg-gray-200 transition"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={() => setShowSlackPicker(false)}
                  className="text-gray-500 hover:text-gray-900 transition text-xl leading-none px-1"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 divide-y divide-gray-200/50">
              {!slackPickerChannel ? (
                /* Channel picker */
                slackChannels.length === 0 ? (
                  <div className="px-5 py-12 text-center text-gray-500 text-sm">Loading channels...</div>
                ) : (
                  slackChannels.map((ch) => (
                    <button
                      key={ch.id}
                      onClick={() => pickSlackChannel(ch.id)}
                      className="w-full text-left px-5 py-3 hover:bg-gray-100/50 transition"
                    >
                      <span className="text-sm text-gray-900">#{ch.name}</span>
                    </button>
                  ))
                )
              ) : slackThreadView ? (
                /* Thread view */
                slackThreadLoading ? (
                  <div className="px-5 py-12 text-center text-gray-500 text-sm">Loading thread...</div>
                ) : (
                  slackThreadReplies.map((msg, i) => (
                    <div key={msg.ts} className="px-5 py-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-gray-600">{msg.user}</span>
                          <span className="text-xs text-gray-500">
                            {new Date(parseFloat(msg.ts) * 1000).toLocaleString()}
                          </span>
                          {i === 0 && <span className="text-xs text-indigo-600">parent</span>}
                        </div>
                        <div className="text-sm text-gray-700 mt-0.5 whitespace-pre-wrap">
                          {msg.text.slice(0, 300)}{msg.text.length > 300 ? "..." : ""}
                        </div>
                      </div>
                      <button
                        onClick={() => runTestOnSlackMessage(msg)}
                        className="text-xs px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white transition shrink-0"
                      >
                        Test this
                      </button>
                    </div>
                  ))
                )
              ) : (
                /* Message list */
                slackMessagesLoading ? (
                  <div className="px-5 py-12 text-center text-gray-500 text-sm">Loading messages...</div>
                ) : slackMessages.length === 0 ? (
                  <div className="px-5 py-12 text-center text-gray-500 text-sm">No messages found</div>
                ) : (
                  slackMessages.map((msg) => (
                    <div key={msg.ts} className="px-5 py-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-gray-600">{msg.user}</span>
                          <span className="text-xs text-gray-500">
                            {new Date(parseFloat(msg.ts) * 1000).toLocaleString()}
                          </span>
                          {msg.reply_count > 0 && (
                            <span className="text-xs text-gray-500">
                              {msg.reply_count} {msg.reply_count === 1 ? "reply" : "replies"}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-700 mt-0.5 whitespace-pre-wrap">
                          {msg.text.slice(0, 300)}{msg.text.length > 300 ? "..." : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {msg.reply_count > 0 && (
                          <button
                            onClick={() => viewSlackThread(msg.ts)}
                            className="text-xs text-indigo-600 hover:text-indigo-500 transition"
                          >
                            View thread
                          </button>
                        )}
                        <button
                          onClick={() => runTestOnSlackMessage(msg)}
                          className="text-xs px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white transition"
                        >
                          Test this
                        </button>
                      </div>
                    </div>
                  ))
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* Test Picker Modal */}
      {showTestPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white border border-gray-200 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Pick an item to test</h2>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 bg-gray-100 rounded-md px-2 py-1">
                  <span className="text-xs text-gray-600">Random</span>
                  <input
                    type="number"
                    min={1}
                    value={randomCount}
                    onChange={(e) => setRandomCount(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-10 bg-gray-200 border border-gray-300 text-gray-900 text-xs rounded px-1.5 py-0.5 text-center"
                  />
                  <button
                    onClick={() => runTestRandom(randomCount)}
                    className="text-xs text-gray-700 hover:text-gray-900 px-2 py-0.5 rounded bg-gray-200 hover:bg-gray-300 transition"
                  >
                    Go
                  </button>
                </div>
                <button
                  onClick={() => setShowTestPicker(false)}
                  className="text-gray-500 hover:text-gray-900 transition text-xl leading-none px-1"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 divide-y divide-gray-200/50">
              {testItemsLoading ? (
                <div className="px-5 py-12 text-center text-gray-500 text-sm">Loading items...</div>
              ) : testItems.length === 0 ? (
                <div className="px-5 py-12 text-center text-gray-500 text-sm">No items found</div>
              ) : (
                testItems.map((item, idx) => {
                  const threadId = item.threadId;
                  const isExpanded = expandedThread === threadId;
                  const msgs = threadMessages[threadId];
                  const isLoadingThread = threadLoading === threadId;
                  // Use first message metadata from loaded thread if available
                  const firstMsg = msgs?.[0];

                  return (
                    <div key={item.id ?? idx} className="px-5 py-3">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">
                              {firstMsg?.subject || item.subject || item.title || item.name || JSON.stringify(item).slice(0, 120)}
                            </span>
                            {(firstMsg?.date || item.date) && (
                              <span className="text-xs text-gray-500 shrink-0">
                                {new Date(firstMsg?.date || item.date).toLocaleDateString()}
                              </span>
                            )}
                            {msgs && (
                              <span className="text-xs text-gray-500 shrink-0">
                                {msgs.length} message{msgs.length !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                          {(firstMsg?.from || item.from) && (
                            <div className="text-xs text-gray-500 truncate mt-0.5">{firstMsg?.from || item.from}</div>
                          )}
                          {item.snippet && (
                            <div className="text-xs text-gray-500 truncate mt-0.5">{item.snippet}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {threadId && (
                            <button
                              onClick={() => toggleThread(threadId)}
                              className="text-xs text-indigo-600 hover:text-indigo-500 transition"
                            >
                              {isExpanded ? "Hide thread" : "View thread"}
                            </button>
                          )}
                          <button
                            onClick={() => runTestOnItem(item)}
                            className="text-xs px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white transition"
                          >
                            Test this
                          </button>
                        </div>
                      </div>

                      {/* Thread preview */}
                      {isExpanded && (
                        <div className="mt-3 ml-2 border-l-2 border-gray-200 pl-3 space-y-3">
                          {isLoadingThread ? (
                            <div className="text-xs text-gray-500 py-2">Loading thread...</div>
                          ) : msgs ? (
                            msgs.map((msg, mi) => (
                              <div key={msg.id ?? mi} className="space-y-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium text-gray-700">{msg.from}</span>
                                  <span className="text-xs text-gray-500">
                                    {msg.date ? new Date(msg.date).toLocaleString() : ""}
                                  </span>
                                </div>
                                <div className="text-xs text-gray-500 whitespace-pre-wrap max-h-32 overflow-y-auto">
                                  {(msg.body || msg.snippet || "").slice(0, 500)}
                                  {(msg.body || "").length > 500 ? "..." : ""}
                                </div>
                              </div>
                            ))
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
