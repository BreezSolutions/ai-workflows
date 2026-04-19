import { Router } from "express";
import * as db from "../../core/db.js";

const VALID_ACTIONS = new Set([
  "send_email", "reply_email", "forward_email", "send_slack",
  "archive_email", "custom", "none", "knowledge_upsert",
]);


/** Check if an email address belongs to us (including plus-tagged aliases) */
function isOurEmail(email: string, myEmail: string): boolean {
  const e = (email.match(/<([^>]+)>/)?.[1] ?? email).toLowerCase().trim();
  const me = myEmail.toLowerCase();
  if (e === me) return true;
  const [localPart, domain] = me.split("@");
  if (!localPart || !domain) return false;
  return e.endsWith(`@${domain}`) && e.split("@")[0]?.startsWith(localPart + "+");
}

/** Generate warnings for a staged action */
async function checkWarnings(action: any, existingActions?: any[], userId?: string): Promise<string[]> {
  const warnings: string[] = [];

  // 1. Self-reply: all recipients are our own address
  if ((action.action === "reply_email" || action.action === "send_email") && action.to?.length) {
    const conn = await db.getConnection("gmail", userId);
    const ourEmail = (conn as any)?.email;
    if (ourEmail) {
      const allToUs = action.to.every((t: string) => isOurEmail(t, ourEmail));
      if (allToUs) {
        warnings.push(`All recipients (${action.to.join(", ")}) appear to be your own email address. Did you mean to reply to the other participants in this thread?`);
      }
    }
  }

  // 2. Empty body
  const body = action.body ?? action.text ?? "";
  if (["send_email", "reply_email", "forward_email", "send_slack"].includes(action.action) && !body.trim()) {
    warnings.push(`The message body is empty.`);
  }

  // 3. Duplicate: same action type with matching key fields already staged
  if (existingActions?.length) {
    const isDup = existingActions.some((existing) => {
      if (existing.action !== action.action) return false;
      switch (action.action) {
        case "send_slack":
          return existing.channel === action.channel &&
            existing.text === action.text &&
            (existing.thread_ts ?? "") === (action.thread_ts ?? "");
        case "reply_email":
          return existing.thread_id === action.thread_id &&
            existing.body === action.body;
        case "send_email":
          return existing.subject === action.subject &&
            existing.body === action.body &&
            JSON.stringify(existing.to) === JSON.stringify(action.to);
        case "forward_email":
          return existing.thread_id === action.thread_id &&
            JSON.stringify(existing.to) === JSON.stringify(action.to);
        default:
          return false;
      }
    });
    if (isDup) {
      warnings.push(`This looks like a duplicate of an action already staged.`);
    }
  }

  return warnings;
}

const router = Router();

// Stage a single action for an execution item
router.post("/:itemId/actions", async (req, res) => {
  try {
    const { itemId } = req.params;
    const action = req.body;

    if (!action?.action || !VALID_ACTIONS.has(action.action)) {
      const hint = action?.type && VALID_ACTIONS.has(action.type)
        ? ` Did you mean { "action": "${action.type}" } instead of { "type": "${action.type}" }?`
        : "";
      return res.status(400).json({
        error: `Invalid action type: ${action?.action}. Valid: ${[...VALID_ACTIONS].join(", ")}.${hint}`,
      });
    }

    // Reject nested "params" pattern — fields must be flat on the action object
    if (action.params) {
      return res.status(400).json({
        error: `Invalid format: fields must be flat on the action object, not nested under "params". Send { "action": "${action.action}", "thread_id": "...", "body": "...", ... } instead of { "action": "${action.action}", "params": { ... } }`,
      });
    }

    // Validate required fields per action type
    const missing: string[] = [];
    switch (action.action) {
      case "reply_email":
        if (!action.thread_id) missing.push("thread_id");
        if (!action.body) missing.push("body");
        break;
      case "send_email":
        if (!action.to?.length) missing.push("to");
        if (!action.subject) missing.push("subject");
        if (!action.body) missing.push("body");
        break;
      case "archive_email":
        if (!action.thread_id) missing.push("thread_id");
        break;
      case "send_slack":
        if (!action.channel) missing.push("channel");
        if (!action.text) missing.push("text");
        break;
      case "knowledge_upsert":
        if (!action.type) missing.push("type");
        if (!action.match_on) missing.push("match_on");
        else if (!Array.isArray(action.match_on)) {
          return res.status(400).json({
            error: `match_on must be an array of field names, e.g. ["event_id"]. Got: ${JSON.stringify(action.match_on)}`,
          });
        }
        if (!action.data) missing.push("data");
        break;
      case "none":
        if (!action.reason) missing.push("reason");
        break;
    }
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required fields for ${action.action}: ${missing.join(", ")}`,
      });
    }

    const item = await db.getItem(itemId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }
    if (item.status !== "running") {
      return res.status(409).json({ error: `Item status is '${item.status}', expected 'running'` });
    }

    const warnings = await checkWarnings(action, item.agent_actions ?? [], (req as any).userId);

    const count = await db.pushItemAction(itemId, action);
    const result: any = { ok: true, index: count - 1, action: action.action };
    if (warnings.length > 0) result.warnings = warnings.map((w) => `WARNING: ${w}`);
    res.json(result);
  } catch (err) {
    console.error("Error staging action:", err);
    res.status(500).json({ error: "Failed to stage action" });
  }
});

// List staged actions for an execution item
router.get("/:itemId/actions", async (req, res) => {
  try {
    const item = await db.getItem(req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }
    const actions = item.agent_actions ?? [];
    res.json({ actions, count: actions.length });
  } catch (err) {
    console.error("Error listing staged actions:", err);
    res.status(500).json({ error: "Failed to list staged actions" });
  }
});

// Replace a staged action by index
router.put("/:itemId/actions/:index", async (req, res) => {
  try {
    const { itemId, index } = req.params;
    const idx = parseInt(index, 10);
    const action = req.body;

    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: "Invalid index" });
    }
    if (!action?.action || !VALID_ACTIONS.has(action.action)) {
      const hint = action?.type && VALID_ACTIONS.has(action.type)
        ? ` Did you mean { "action": "${action.type}" } instead of { "type": "${action.type}" }?`
        : "";
      return res.status(400).json({
        error: `Invalid action type: ${action?.action}. Valid: ${[...VALID_ACTIONS].join(", ")}.${hint}`,
      });
    }

    const item = await db.getItem(itemId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }
    if (item.status !== "running") {
      return res.status(409).json({ error: `Item status is '${item.status}', expected 'running'` });
    }

    const actions: any[] = item.agent_actions ?? [];
    if (idx >= actions.length) {
      return res.status(400).json({ error: `Index ${idx} out of range (${actions.length} actions)` });
    }

    actions[idx] = action;
    await db.updateItem(itemId, { agent_actions: actions });

    // Check warnings, excluding self from duplicate check
    const otherActions = actions.filter((_: any, i: number) => i !== idx);
    const warnings = await checkWarnings(action, otherActions, (req as any).userId);

    const result: any = { ok: true, index: idx, action: action.action };
    if (warnings.length > 0) result.warnings = warnings.map((w) => `WARNING: ${w}`);
    res.json(result);
  } catch (err) {
    console.error("Error updating staged action:", err);
    res.status(500).json({ error: "Failed to update action" });
  }
});

// Remove a staged action by index
router.delete("/:itemId/actions/:index", async (req, res) => {
  try {
    const { itemId, index } = req.params;
    const idx = parseInt(index, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: "Invalid index" });
    }

    const item = await db.getItem(itemId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }
    if (item.status !== "running") {
      return res.status(409).json({ error: `Item status is '${item.status}', expected 'running'` });
    }

    const remaining = await db.removeItemAction(itemId, idx);
    res.json({ ok: true, remaining });
  } catch (err) {
    console.error("Error removing staged action:", err);
    res.status(500).json({ error: "Failed to remove action" });
  }
});

export default router;
