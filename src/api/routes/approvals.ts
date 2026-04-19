import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as db from "../../core/db.js";
import type { ExecutionItem } from "../../core/types.js";
import { executeAction, type WorkflowAction } from "../../core/actions.js";
import { notifyItemExecution } from "../../core/slack-notify.js";
import { isQueuedAction, enqueueActions, getQueueStatus } from "../../core/action-queue.js";

const anthropic = new Anthropic();

const router = Router();

// List pending approvals
router.get("/", async (req, res) => {
  try {
    const workflowId = req.query.workflow_id as string | undefined;
    const items = await db.listPendingApprovals(workflowId);
    res.json(items);
  } catch (err) {
    console.error("Error listing approvals:", err);
    res.status(500).json({ error: "Failed to list approvals" });
  }
});

// Email queue status
router.get("/queue-status", (_req, res) => {
  res.json(getQueueStatus());
});

// Suggest a prompt change based on rejection/edit feedback
router.post("/suggest-prompt-change", async (req, res) => {
  try {
    const { itemId, actionIndex, reason, type } = req.body as {
      itemId: string;
      actionIndex: number;
      reason: string;
      type: "reject" | "edit";
    };

    const item = await db.getItem(itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    const run = await db.getRun(item.run_id);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const workflow = await db.getWorkflow(run.workflow_id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    const action = (item.agent_actions ?? [])[actionIndex];

    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are helping improve an AI workflow's action prompt. The workflow processes items and generates actions (emails, Slack messages, etc.). A human reviewer ${type === "reject" ? "rejected" : "edited"} one of the AI's proposed actions and gave feedback.

Your job: suggest a **minimal, targeted edit** to the action prompt that would prevent this issue in future runs. Don't rewrite the whole prompt — just add or modify the specific part needed.

## Current Action Prompt
${workflow.action_prompt}

## Item Data (what the AI was working with)
${JSON.stringify(item.item_data, null, 2)}

## Action the AI Proposed${actionIndex !== undefined ? ` (action ${actionIndex + 1})` : ""}
${JSON.stringify(action, null, 2)}

## Human's Feedback
Type: ${type === "reject" ? "Rejected the action" : "Edited the action before approving"}
Reason: ${reason}

## Instructions
- Return ONLY the updated action prompt text — no explanation, no markdown fences
- Make the smallest change that addresses the feedback
- Preserve the existing style, tone, and structure of the prompt
- Add the new guidance where it fits most naturally
- Be specific rather than vague (e.g., "if X, then do Y" rather than "be careful about X")
- Don't add guidance that's too specific to this one item — generalize the lesson`,
        },
      ],
    });

    const suggestion =
      response.content[0].type === "text" ? response.content[0].text : "";

    res.json({
      suggestion,
      currentPrompt: workflow.action_prompt,
      workflowId: workflow.id,
    });
  } catch (err) {
    console.error("Error suggesting prompt change:", err);
    res.status(500).json({ error: "Failed to generate suggestion" });
  }
});

// Approve an item (optionally with specific action indices)
router.post("/:id/approve", async (req, res) => {
  try {
    const { actionIndices } = req.body as { actionIndices?: number[] };

    let item: ExecutionItem | null;
    if (actionIndices) {
      // Partial approve (single action) — don't claim the whole item yet
      item = await db.getItem(req.params.id);
      if (!item) return res.status(404).json({ error: "Item not found" });
    } else {
      // Full approve — atomically claim to prevent duplicate execution
      item = await db.claimItemForApproval(req.params.id);
      if (!item) {
        const existing = await db.getItem(req.params.id);
        if (!existing) return res.status(404).json({ error: "Item not found" });
        return res.json(existing);
      }
    }

    const actions = (item.agent_actions ?? []) as (WorkflowAction & { _status?: string; _result?: string })[];
    const toExecute = actionIndices ?? actions.map((_, i) => i);

    // Separate email actions (queued) from non-email actions (executed immediately)
    const queuedActions: { index: number; action: WorkflowAction }[] = [];

    for (const i of toExecute) {
      if (i < 0 || i >= actions.length) continue;
      if (actions[i]._status === "executed") continue;

      if (isQueuedAction(actions[i])) {
        // Mark as queued — will be processed by the background email queue
        actions[i]._status = "queued";
        queuedActions.push({ index: i, action: actions[i] });
      } else {
        // Execute non-email actions immediately (archive, slack, knowledge, etc.)
        // Small delay between actions to avoid hammering APIs
        if (i !== toExecute[0]) {
          await new Promise((r) => setTimeout(r, 100));
        }
        try {
          const r = await executeAction(actions[i]);
          actions[i]._status = "executed";
          actions[i]._result = r;
        } catch (err) {
          actions[i]._status = "failed";
          actions[i]._result = `${err}`;
        }
      }
    }

    // Save current state (queued emails + completed non-emails)
    const hasQueued = queuedActions.length > 0;
    const updates: Record<string, any> = {
      agent_actions: actions,
    };
    // Only set completed_at if there are no queued emails
    if (!hasQueued) {
      updates.completed_at = new Date().toISOString();
    }
    const updated = await db.updateItem(item.id, updates);

    // Enqueue email actions for background processing with 5s gaps
    if (hasQueued) {
      enqueueActions(item.id, queuedActions);
    }

    // If no emails were queued, notify Slack immediately
    if (!hasQueued) {
      const allDone = actions.every((a) => a._status === "executed");
      if (allDone) {
        const run = await db.getRun(item.run_id);
        if (run) {
          const workflow = await db.getWorkflow(run.workflow_id);
          if (workflow?.slack_action_channel) {
            notifyItemExecution(workflow.slack_action_channel, updated, {
              approvedBy: "Akshaj",
              workflowName: workflow.name,
            }).catch((err) => console.error("Slack notify error:", err));
          }
        }
      }
    }
    // (If emails were queued, the email-queue module handles notification after all complete)

    res.json(updated);
  } catch (err) {
    console.error("Error approving item:", err);
    res.status(500).json({ error: "Failed to approve item" });
  }
});

// Edit a single action before approving
router.put("/:id/actions/:index", async (req, res) => {
  try {
    const item = await db.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.status !== "awaiting_approval") {
      return res.status(400).json({ error: "Item is not awaiting approval" });
    }

    const index = parseInt(req.params.index);
    const actions = (item.agent_actions ?? []) as any[];
    if (index < 0 || index >= actions.length) {
      return res.status(400).json({ error: "Invalid action index" });
    }

    actions[index] = { ...actions[index], ...req.body };
    const updated = await db.updateItem(item.id, { agent_actions: actions });
    res.json(updated);
  } catch (err) {
    console.error("Error editing action:", err);
    res.status(500).json({ error: "Failed to edit action" });
  }
});

// Reject an item (or a single action within it)
router.post("/:id/reject", async (req, res) => {
  try {
    const { actionIndex } = req.body as { actionIndex?: number };
    const item = await db.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });

    if (actionIndex !== undefined) {
      // Reject a single action
      const actions = (item.agent_actions ?? []) as any[];
      if (actionIndex >= 0 && actionIndex < actions.length) {
        actions[actionIndex]._status = "rejected";
      }
      // If all actions now have a terminal status, mark the whole item completed
      const allDone = actions.every((a: any) => ["executed", "rejected", "failed"].includes(a._status));
      const updates: Record<string, any> = { agent_actions: actions };
      if (allDone) {
        updates.status = "rejected";
        updates.completed_at = new Date().toISOString();
      }
      const updated = await db.updateItem(req.params.id, updates);
      res.json(updated);
    } else {
      // Reject the entire item
      const updated = await db.updateItem(req.params.id, {
        status: "rejected",
        completed_at: new Date().toISOString(),
      });
      res.json(updated);
    }
  } catch (err) {
    console.error("Error rejecting item:", err);
    res.status(500).json({ error: "Failed to reject item" });
  }
});

// Clear pending approvals (optionally filtered by workflow)
router.delete("/", async (req, res) => {
  try {
    const workflowId = req.query.workflow_id as string | undefined;
    const count = await db.clearPendingApprovals(workflowId);
    res.json({ deleted: count });
  } catch (err) {
    console.error("Error clearing approvals:", err);
    res.status(500).json({ error: "Failed to clear approvals" });
  }
});

export default router;
