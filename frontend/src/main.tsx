import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import WorkflowEditor from "./pages/WorkflowEditor";
import WorkflowDetail from "./pages/WorkflowDetail";
import Approvals from "./pages/Approvals";
import Activity from "./pages/Activity";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="workflows/new" element={<WorkflowEditor />} />
          <Route path="workflows/:id" element={<WorkflowDetail />} />
          <Route path="workflows/:id/edit" element={<WorkflowEditor />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="activity" element={<Activity />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
