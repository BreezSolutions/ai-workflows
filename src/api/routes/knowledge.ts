import { Router } from "express";
import multer from "multer";
import * as db from "../../core/db.js";
import * as s3 from "../../core/s3.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---- Knowledge Types ----

router.get("/types", async (_req, res) => {
  try {
    const types = await db.listKnowledgeTypes();
    res.json(types);
  } catch (err) {
    console.error("Error listing knowledge types:", err);
    res.status(500).json({ error: "Failed to list types" });
  }
});

router.post("/types", async (req, res) => {
  try {
    const kt = await db.createKnowledgeType(req.body);
    res.status(201).json(kt);
  } catch (err: any) {
    if (err.code === 11000) return res.status(409).json({ error: "Type name already exists" });
    console.error("Error creating knowledge type:", err);
    res.status(500).json({ error: "Failed to create type" });
  }
});

router.put("/types/:id", async (req, res) => {
  try {
    const kt = await db.updateKnowledgeType(req.params.id, req.body);
    res.json(kt);
  } catch (err) {
    console.error("Error updating knowledge type:", err);
    res.status(500).json({ error: "Failed to update type" });
  }
});

router.delete("/types/:id", async (req, res) => {
  try {
    await db.deleteKnowledgeType(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error("Error deleting knowledge type:", err);
    res.status(500).json({ error: "Failed to delete type" });
  }
});

// ---- Knowledge Records ----

router.get("/records", async (req, res) => {
  try {
    const type = req.query.type as string | undefined;
    const search = req.query.search as string | undefined;
    const format = req.query.format as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    const records = await db.listKnowledge({ type, search, limit });

    if (format === "text") {
      // CLI-friendly table format
      res.type("text/plain").send(formatRecordsTable(records, type));
      return;
    }

    res.json(records);
  } catch (err) {
    console.error("Error listing knowledge records:", err);
    res.status(500).json({ error: "Failed to list records" });
  }
});

router.get("/counts", async (_req, res) => {
  try {
    const counts = await db.countKnowledgeByType();
    res.json(counts);
  } catch (err) {
    console.error("Error counting knowledge:", err);
    res.status(500).json({ error: "Failed to count" });
  }
});

router.get("/records/:id", async (req, res) => {
  try {
    const record = await db.getKnowledge(req.params.id);
    if (!record) return res.status(404).json({ error: "Not found" });
    res.json(record);
  } catch (err) {
    console.error("Error getting knowledge record:", err);
    res.status(500).json({ error: "Failed to get record" });
  }
});

router.post("/records", async (req, res) => {
  try {
    const record = await db.createKnowledge(req.body);
    res.status(201).json({ ...record, _summary: summarizeRecord("Created", record) });
  } catch (err) {
    console.error("Error creating knowledge record:", err);
    res.status(500).json({ error: "Failed to create record" });
  }
});

router.post("/records/upsert", async (req, res) => {
  try {
    const { type, match_on, data, created_by } = req.body;
    if (!type || !match_on || !data) {
      return res.status(400).json({ error: "type, match_on, and data are required" });
    }
    const record = await db.upsertKnowledge(type, match_on, data, created_by || "agent");
    res.json({ ...record, _summary: summarizeRecord("Upserted", record) });
  } catch (err) {
    console.error("Error upserting knowledge record:", err);
    res.status(500).json({ error: "Failed to upsert record" });
  }
});

router.put("/records/:id", async (req, res) => {
  try {
    const record = await db.updateKnowledge(req.params.id, req.body);
    res.json({ ...record, _summary: summarizeRecord("Updated", record) });
  } catch (err) {
    console.error("Error updating knowledge record:", err);
    res.status(500).json({ error: "Failed to update record" });
  }
});

router.delete("/records/:id", async (req, res) => {
  try {
    await db.deleteKnowledge(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error("Error deleting knowledge record:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

// ---- Attachments ----

router.post("/records/:id/attachments", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file provided" });

    const record = await db.getKnowledge(req.params.id as string);
    if (!record) return res.status(404).json({ error: "Record not found" });

    const key = s3.generateKey(record.type, file.originalname);
    await s3.uploadFile(key, file.buffer, file.mimetype);

    const attachment = {
      filename: file.originalname,
      s3_key: key,
      mime_type: file.mimetype,
      size_bytes: file.size,
      uploaded_at: new Date().toISOString(),
    };
    await db.addKnowledgeAttachment(req.params.id as string, attachment);

    res.status(201).json(attachment);
  } catch (err) {
    console.error("Error uploading attachment:", err);
    res.status(500).json({ error: "Failed to upload attachment" });
  }
});

router.get("/records/:id/attachments/:s3Key(*)", async (req, res) => {
  try {
    const s3Key = (req.params as any)[0] || (req.params as any)["s3Key(*)"];
    const url = await s3.getPresignedUrl(s3Key);
    res.json({ url });
  } catch (err) {
    console.error("Error getting attachment URL:", err);
    res.status(500).json({ error: "Failed to get attachment URL" });
  }
});

router.delete("/records/:id/attachments/:s3Key(*)", async (req, res) => {
  try {
    const s3Key = (req.params as any)[0] || (req.params as any)["s3Key(*)"];
    await s3.deleteFile(s3Key);
    await db.removeKnowledgeAttachment(req.params.id as string, s3Key);
    res.status(204).end();
  } catch (err) {
    console.error("Error deleting attachment:", err);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
});

// ---- Record summary for agent feedback ----

function summarizeRecord(action: string, record: any): string {
  const type = record.type || "unknown";
  const data = record.data || {};
  const fields = Object.entries(data)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return `${action} ${type} record (id: ${record.id})\n${fields}`;
}

// ---- CLI table formatter ----

function formatRecordsTable(records: any[], type?: string): string {
  if (records.length === 0) return type ? `No records of type "${type}".` : "No records found.";

  // Collect all data keys across records
  const allKeys = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.data || {})) allKeys.add(k);
  }
  const keys = Array.from(allKeys);

  // Calculate column widths
  const widths: Record<string, number> = {};
  for (const k of keys) {
    widths[k] = k.length;
    for (const r of records) {
      const val = formatCell(r.data?.[k]);
      widths[k] = Math.max(widths[k], val.length);
    }
    widths[k] = Math.min(widths[k], 40); // cap at 40 chars
  }

  // Build table
  const header = keys.map((k) => k.padEnd(widths[k])).join("  |  ");
  const sep = keys.map((k) => "-".repeat(widths[k])).join("--+--");
  const rows = records.map((r) =>
    keys.map((k) => formatCell(r.data?.[k]).padEnd(widths[k])).join("  |  ")
  );

  const title = type ? `${type} (${records.length} records)` : `All records (${records.length})`;
  return [title, "", header, sep, ...rows].join("\n");
}

function formatCell(val: any): string {
  if (val == null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  const s = String(val);
  return s.length > 40 ? s.slice(0, 37) + "..." : s;
}

export default router;
