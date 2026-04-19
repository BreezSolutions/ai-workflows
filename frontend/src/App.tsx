import { useState, useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useSocket, useToasts, type WorkflowEvent } from "./useSocket";
import { getAuthUser, logout, type AppUser } from "./api";
import Login from "./pages/Login";

const EVENT_MESSAGES: Record<string, (e: WorkflowEvent) => string> = {
  run_started: (e) => `"${e.workflowName}" started`,
  run_completed: (e) => `"${e.workflowName}" completed`,
  item_staged: (e) => `"${e.workflowName}" — item staged for approval`,
  item_completed: (e) => `"${e.workflowName}" — item completed`,
  item_failed: (e) => `"${e.workflowName}" — item failed`,
};

const EVENT_TYPES: Record<string, "info" | "success" | "error"> = {
  run_started: "info",
  run_completed: "success",
  item_staged: "info",
  item_completed: "success",
  item_failed: "error",
};

const navClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm transition ${isActive ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:text-gray-900"}`;

function App() {
  const { toasts, addToast } = useToasts();
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    getAuthUser().then(setUser).catch(() => setUser(null)).finally(() => setAuthLoading(false));
  }, []);

  useSocket((event) => {
    const msg = EVENT_MESSAGES[event.type]?.(event) ?? event.type;
    addToast(msg, EVENT_TYPES[event.type] ?? "info");
  });

  if (authLoading) {
    return <div className="min-h-screen bg-white flex items-center justify-center"><span className="text-gray-500 text-sm">Loading...</span></div>;
  }
  if (!user) return <Login />;

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <nav className="border-b border-gray-200 bg-white/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center gap-6">
          <span className="font-semibold text-gray-900 tracking-tight">AI Workflows</span>
          <div className="flex gap-1 ml-4">
            <NavLink to="/dashboard" className={navClass}>Dashboard</NavLink>
            <NavLink to="/approvals" className={navClass}>Approvals</NavLink>
            <NavLink to="/activity" className={navClass}>Activity</NavLink>
            <NavLink to="/workflows/new" className={navClass}>+ New Workflow</NavLink>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {user.picture && <img src={user.picture} alt="" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />}
            <span className="text-xs text-gray-600">{user.name}</span>
            <button
              onClick={() => logout().then(() => window.location.reload())}
              className="text-xs text-gray-500 hover:text-gray-900 ml-2"
            >Sign out</button>
          </div>
        </div>
      </nav>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Outlet />
      </main>

      <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-sm max-w-sm animate-[slideIn_0.2s_ease-out] ${
              toast.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : toast.type === "error"
                ? "bg-red-50 text-red-800 border border-red-200"
                : "bg-white text-gray-900 border border-gray-200"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
