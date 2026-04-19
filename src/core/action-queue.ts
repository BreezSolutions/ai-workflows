/**
 * Global action queue — serializes external API calls (Gmail, Slack, etc.)
 * with a configurable delay between them per action type.
 *
 * This avoids flooding APIs with concurrent requests and reduces duplicate
 * notifications from the EMA watcher (whose history-based dedup races
 * when many Pub/Sub events arrive at once).
 */

import { executeAction, type WorkflowAction } from "./actions.js";
import * as db from "./db.js";
import { notifyItemExecution } from "./slack-notify.js";

// Delay between sends per action type
const DELAY_MS: Record<string, number> = {
  reply_email: 5_000,
  send_email: 5_000,
  forward_email: 5_000,
  send_slack: 5_000,
};

// Actions that go through the queue (everything with an external API call)
const QUEUED_ACTIONS = new Set(Object.keys(DELAY_MS));

interface QueueEntry {
  itemId: string;
  actionIndex: number;
  action: WorkflowAction;
}

let queue: QueueEntry[] = [];
let processing = false;

export function isQueuedAction(action: WorkflowAction): boolean {
  return QUEUED_ACTIONS.has(action.action);
}

/**
 * Enqueue actions for background processing.
 * Actions should already be marked as "queued" in the DB.
 */
export function enqueueActions(
  itemId: string,
  actions: { index: number; action: WorkflowAction }[],
) {
  for (const { index, action } of actions) {
    queue.push({ itemId, actionIndex: index, action });
  }
  if (!processing) {
    processQueue();
  }
}

async function processQueue() {
  processing = true;

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const delay = DELAY_MS[entry.action.action] ?? 1_000;

    try {
      const result = await executeAction(entry.action);
      await updateActionStatus(entry.itemId, entry.actionIndex, "executed", result);
    } catch (err) {
      await updateActionStatus(entry.itemId, entry.actionIndex, "failed", `${err}`);
    }

    await checkAndNotifyCompletion(entry.itemId);

    // Wait before next action (but not after the last one)
    if (queue.length > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  processing = false;
}

async function updateActionStatus(
  itemId: string,
  actionIndex: number,
  status: string,
  result: string,
) {
  try {
    const item = await db.getItem(itemId);
    if (!item) return;

    const actions = (item.agent_actions ?? []) as any[];
    if (actionIndex < actions.length) {
      actions[actionIndex]._status = status;
      actions[actionIndex]._result = result;
    }

    await db.updateItem(itemId, { agent_actions: actions });
  } catch (err) {
    console.error(`[action-queue] Failed to update status for item ${itemId}:`, err);
  }
}

async function checkAndNotifyCompletion(itemId: string) {
  try {
    const item = await db.getItem(itemId);
    if (!item) return;

    const actions = (item.agent_actions ?? []) as any[];
    const allDone = actions.every(
      (a: any) => a._status === "executed" || a._status === "failed" || a.action === "none" || a.action === "custom",
    );

    if (!allDone) return;

    if (!item.completed_at) {
      await db.updateItem(itemId, { completed_at: new Date().toISOString() });
    }

    const allExecuted = actions.every(
      (a: any) => a._status === "executed" || a.action === "none" || a.action === "custom",
    );
    if (allExecuted) {
      const run = await db.getRun(item.run_id);
      if (run) {
        const workflow = await db.getWorkflow(run.workflow_id);
        if (workflow?.slack_action_channel) {
          console.log(`[action-queue] All actions done for ${itemId}, notifying ${workflow.slack_action_channel}`);
          const updated = await db.getItem(itemId);
          if (updated) {
            notifyItemExecution(workflow.slack_action_channel, updated, {
              approvedBy: "Akshaj",
              workflowName: workflow.name,
            }).catch((err) => console.error("Slack notify error:", err));
          }
        } else {
          console.log(`[action-queue] All actions done for ${itemId}, no slack_action_channel configured`);
        }
      }
    } else {
      console.log(`[action-queue] Item ${itemId}: not all done yet`, actions.map((a: any) => `${a.action}:${a._status}`));
    }
  } catch (err) {
    console.error(`[action-queue] Failed to check completion for item ${itemId}:`, err);
  }
}

/** Get current queue length (for API/debugging) */
export function getQueueStatus() {
  return { length: queue.length, processing };
}
