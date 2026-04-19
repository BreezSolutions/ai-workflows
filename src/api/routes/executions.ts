import { Router } from "express";
import * as db from "../../core/db.js";
import { abortRun } from "../../core/runner.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const workflowId = req.query.workflow_id as string | undefined;
    const runs = await db.listRuns(workflowId);
    res.json(runs);
  } catch (err) {
    console.error("Error listing runs:", err);
    res.status(500).json({ error: "Failed to list runs" });
  }
});

router.get("/completed/items", async (req, res) => {
  try {
    const workflowId = req.query.workflow_id as string | undefined;
    const items = await db.listCompletedItems(workflowId);
    res.json(items);
  } catch (err) {
    console.error("Error listing completed items:", err);
    res.status(500).json({ error: "Failed to list completed items" });
  }
});

router.get("/:id/items", async (req, res) => {
  try {
    const items = await db.listItems(req.params.id);
    res.json(items);
  } catch (err) {
    console.error("Error listing items:", err);
    res.status(500).json({ error: "Failed to list items" });
  }
});

// Clean up stale "running" runs (from crashes)
router.post("/cleanup", async (_req, res) => {
  try {
    const count = await db.cleanupStaleRuns();
    res.json({ cleaned: count });
  } catch (err) {
    console.error("Error cleaning up runs:", err);
    res.status(500).json({ error: "Failed to clean up" });
  }
});

// Abort a running execution
router.post("/:id/abort", async (req, res) => {
  try {
    abortRun(req.params.id);
    await db.addRunLog(req.params.id, "warn", "Abort requested by user");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error aborting run:", err);
    res.status(500).json({ error: "Failed to abort run" });
  }
});

export default router;
