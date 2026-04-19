import { Router } from "express";
import * as db from "../../core/db.js";
import { runWorkflow, testWorkflow, applySkipConditions } from "../../core/runner.js";
import { fetchList, fetchListCount, fetchListPreview, fetchGmailThread } from "../../core/list-fetchers.js";

const router = Router();

// Preview list count (no AI filtering)
router.post("/:id/preview-list", async (req, res) => {
  try {
    const workflow = await db.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });
    if (!workflow.list_source) return res.status(400).json({ error: "Workflow has no list source" });

    const count = await fetchListCount(workflow.list_source, workflow.list_config);
    res.json({ count });
  } catch (err) {
    console.error("Error previewing list:", err);
    res.status(500).json({ error: "Failed to fetch list" });
  }
});

// Preview list count from unsaved form data
router.post("/preview-list", async (req, res) => {
  try {
    const { list_source, list_config, preview, skip_condition } = req.body;
    if (!list_source) return res.status(400).json({ error: "No list source" });

    // Skip conditions like no_external_reply and max_messages need full thread data,
    // so use fetchList (full fetch) instead of the lightweight preview when they're present
    const needsFullFetch = skip_condition && (Array.isArray(skip_condition) ? skip_condition : [skip_condition])
      .some((sc: any) => sc.source === "no_external_reply" || sc.source === "max_messages" || sc.source === "recent_activity");

    if (preview) {
      let items = needsFullFetch
        ? await fetchList(list_source, list_config ?? {})
        : await fetchListPreview(list_source, list_config ?? {});
      if (skip_condition) {
        items = await applySkipConditions(items, skip_condition);
      }
      res.json({ count: items.length, items: items.slice(0, 5) });
      return;
    }

    if (skip_condition) {
      let items = needsFullFetch
        ? await fetchList(list_source, list_config ?? {})
        : await fetchListPreview(list_source, list_config ?? {});
      items = await applySkipConditions(items, skip_condition);
      res.json({ count: items.length });
      return;
    }

    const count = await fetchListCount(list_source, list_config ?? {});
    res.json({ count });
  } catch (err) {
    console.error("Error previewing list:", err);
    res.status(500).json({ error: "Failed to fetch list" });
  }
});

// Fetch list items for test picker (lightweight — no bodies for Gmail)
router.get("/:id/test-items", async (req, res) => {
  try {
    const workflow = await db.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });
    if (!workflow.list_source) return res.status(400).json({ error: "No list source" });

    const items = await fetchListPreview(workflow.list_source, workflow.list_config);
    res.json(items);
  } catch (err) {
    console.error("Error fetching test items:", err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

// Fetch full Gmail thread for preview
router.get("/:id/test-items/thread/:threadId", async (req, res) => {
  try {
    const messages = await fetchGmailThread(req.params.threadId);
    res.json(messages);
  } catch (err) {
    console.error("Error fetching thread:", err);
    res.status(500).json({ error: "Failed to fetch thread" });
  }
});

// Test a workflow with one item, always staged
// Accepts { item } for list-based, or { triggerData } for trigger-based workflows
router.post("/:id/test", async (req, res) => {
  try {
    const workflow = await db.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    const specificItem = req.body?.item as Record<string, any> | undefined;
    const triggerData = req.body?.triggerData as Record<string, any> | undefined;
    const count = Math.max(parseInt(req.body?.count) || 1, 1);

    // Allow trigger-based test even without list source
    if (!workflow.list_source && !triggerData) {
      return res.status(400).json({ error: "Workflow has no list source. Provide triggerData for trigger-based test." });
    }

    const run = await db.createRun(workflow.id, "test");
    res.json({ run_id: run.id, status: "testing" });

    if (triggerData) {
      // Trigger-based test — mark with _triggerTest flag so runner adds test preamble
      testWorkflow(workflow, run, { ...triggerData, _triggerTest: true }).catch((err) =>
        console.error(`Test workflow ${workflow.id} failed:`, err)
      );
    } else {
      testWorkflow(workflow, run, specificItem, count).catch((err) =>
        console.error(`Test workflow ${workflow.id} failed:`, err)
      );
    }
  } catch (err) {
    console.error("Error testing workflow:", err);
    res.status(500).json({ error: "Failed to test workflow" });
  }
});

// Manually trigger a workflow
router.post("/:id/trigger", async (req, res) => {
  try {
    const workflow = await db.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    const limit = req.body?.limit ? parseInt(req.body.limit) : undefined;

    // Start execution in background
    const run = await db.createRun(workflow.id, "manual");
    res.json({ run_id: run.id, status: "started" });

    // Fire and forget
    runWorkflow(workflow, run, undefined, limit).catch((err) =>
      console.error(`Workflow ${workflow.id} failed:`, err)
    );
  } catch (err) {
    console.error("Error triggering workflow:", err);
    res.status(500).json({ error: "Failed to trigger workflow" });
  }
});

export default router;
