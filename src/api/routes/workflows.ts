import { Router } from "express";
import * as db from "../../core/db.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const workflows = await db.listWorkflows();
    res.json(workflows);
  } catch (err) {
    console.error("Error listing workflows:", err);
    res.status(500).json({ error: "Failed to list workflows" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const workflow = await db.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: "Not found" });
    res.json(workflow);
  } catch (err) {
    console.error("Error getting workflow:", err);
    res.status(500).json({ error: "Failed to get workflow" });
  }
});

router.post("/", async (req, res) => {
  try {
    const workflow = await db.createWorkflow(req.body);
    res.status(201).json(workflow);
  } catch (err) {
    console.error("Error creating workflow:", err);
    res.status(500).json({ error: "Failed to create workflow" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const workflow = await db.updateWorkflow(req.params.id, req.body);
    res.json(workflow);
  } catch (err) {
    console.error("Error updating workflow:", err);
    res.status(500).json({ error: "Failed to update workflow" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.deleteWorkflow(req.params.id);
    res.status(204).send();
  } catch (err) {
    console.error("Error deleting workflow:", err);
    res.status(500).json({ error: "Failed to delete workflow" });
  }
});

export default router;
