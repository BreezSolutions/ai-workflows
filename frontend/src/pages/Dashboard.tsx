import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listWorkflows, updateWorkflow, deleteWorkflow, triggerWorkflow, listConnections, type Workflow } from "../api";

const TRIGGER_LABELS: Record<string, string> = {
  cron: "Cron",
  slack_message: "Slack",
  gmail_poll: "Gmail",
  manual: "Manual",
};

export default function Dashboard() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectedServices, setConnectedServices] = useState<Set<string>>(new Set());

  const load = () => {
    listWorkflows()
      .then(setWorkflows)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    listConnections()
      .then((conns) => setConnectedServices(new Set(conns.map((c) => c.service))))
      .catch(() => {});
  }, []);

  const getMissingConnections = (w: Workflow): string[] => {
    const missing: string[] = [];
    if ((w.trigger_type === "gmail_poll" || w.list_source === "gmail") && !connectedServices.has("gmail")) {
      missing.push("Gmail");
    }
    return missing;
  };

  const toggle = async (w: Workflow) => {
    await updateWorkflow(w.id, { enabled: !w.enabled });
    load();
  };

  const remove = async (w: Workflow) => {
    if (!confirm(`Delete "${w.name}"?`)) return;
    await deleteWorkflow(w.id);
    load();
  };

  const trigger = async (w: Workflow) => {
    await triggerWorkflow(w.id);
    alert(`Triggered "${w.name}"`);
  };

  if (loading) return <p className="text-gray-500">Loading...</p>;

  if (workflows.length === 0)
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 mb-4">No workflows yet</p>
        <Link
          to="/workflows/new"
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-md"
        >
          Create your first workflow
        </Link>
      </div>
    );

  return (
    <div className="space-y-3">
      {workflows.map((w) => {
        const missing = getMissingConnections(w);
        return (
          <div key={w.id} className="bg-white border border-gray-200 rounded-lg">
            <div className="flex items-center gap-4 px-5 py-4">
              <button
                onClick={() => toggle(w)}
                className={`w-10 h-5 rounded-full relative transition ${
                  w.enabled ? "bg-green-600" : "bg-gray-200"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    w.enabled ? "left-5" : "left-0.5"
                  }`}
                />
              </button>

              <Link to={`/workflows/${w.id}`} className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{w.name}</div>
                <div className="text-sm text-gray-500 flex gap-3 mt-0.5">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 inline-block" />
                    {TRIGGER_LABELS[w.trigger_type] ?? w.trigger_type}
                  </span>
                  {w.list_source && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                      {w.list_source}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                    {w.action_mode}
                  </span>
                </div>
              </Link>

              <div className="flex gap-2 shrink-0">
                {["slack_message", "gmail_poll"].includes(w.trigger_type) ? (
                  w.enabled && (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-700 px-3 py-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Listening
                    </span>
                  )
                ) : (
                  <button
                    onClick={() => trigger(w)}
                    className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 transition"
                  >
                    Run
                  </button>
                )}
                <Link
                  to={`/workflows/${w.id}/edit`}
                  className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 transition"
                >
                  Edit
                </Link>
                <button
                  onClick={() => remove(w)}
                  className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-red-100/50 text-gray-700 hover:text-red-600 transition"
                >
                  Delete
                </button>
              </div>
            </div>

            {missing.length > 0 && (
              <Link
                to="/connections"
                className="flex items-center gap-2 px-5 py-2 border-t border-gray-200 text-xs text-amber-700 hover:text-amber-700 hover:bg-amber-100/10 transition"
              >
                <span>&#9888;</span>
                {missing.join(", ")} not connected — click to set up
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
