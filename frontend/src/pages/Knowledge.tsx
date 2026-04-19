import { useEffect, useState, useCallback } from "react";
import {
  listKnowledgeTypes, createKnowledgeType, updateKnowledgeType, deleteKnowledgeType,
  listKnowledgeRecords, createKnowledgeRecord, updateKnowledgeRecord, deleteKnowledgeRecord,
  getKnowledgeCounts, getAttachmentUrl, uploadKnowledgeAttachment,
  type KnowledgeType, type KnowledgeRecord, type KnowledgeTypeField,
} from "../api";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Knowledge() {
  const [types, setTypes] = useState<KnowledgeType[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(false);

  // Modals
  const [showTypeModal, setShowTypeModal] = useState(false);
  const [editingType, setEditingType] = useState<KnowledgeType | null>(null);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [editingRecord, setEditingRecord] = useState<KnowledgeRecord | null>(null);
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null);

  const loadTypes = useCallback(async () => {
    const [t, c] = await Promise.all([listKnowledgeTypes(), getKnowledgeCounts()]);
    setTypes(t);
    setCounts(c);
    setLoading(false);
  }, []);

  useEffect(() => { loadTypes(); }, [loadTypes]);

  const loadRecords = useCallback(async (type: string | null, searchTerm: string) => {
    setRecordsLoading(true);
    const recs = await listKnowledgeRecords(type || undefined, searchTerm || undefined);
    setRecords(recs);
    setRecordsLoading(false);
  }, []);

  useEffect(() => {
    loadRecords(selectedType, search);
  }, [selectedType, search, loadRecords]);

  const selectedTypeObj = types.find((t) => t.name === selectedType);

  if (loading) return <p className="text-gray-500">Loading...</p>;

  return (
    <div className="flex gap-6 min-h-[60vh]">
      {/* Left sidebar — types */}
      <div className="w-56 shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Types</h2>
          <button
            onClick={() => { setEditingType(null); setShowTypeModal(true); }}
            className="text-xs text-indigo-600 hover:text-indigo-500 transition"
          >
            + Add
          </button>
        </div>

        <button
          onClick={() => setSelectedType(null)}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition ${
            !selectedType ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:text-gray-900 hover:bg-white"
          }`}
        >
          All records
          <span className="text-xs text-gray-500 ml-1">
            ({Object.values(counts).reduce((a, b) => a + b, 0)})
          </span>
        </button>

        {types.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedType(t.name)}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition group ${
              selectedType === t.name ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:text-gray-900 hover:bg-white"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="truncate">{t.label}</span>
              <span className="text-xs text-gray-500">{counts[t.name] || 0}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Main area — records */}
      <div className="flex-1 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-gray-900">
              {selectedTypeObj?.label || "All Records"}
            </h1>
            {selectedTypeObj && (
              <button
                onClick={() => { setEditingType(selectedTypeObj); setShowTypeModal(true); }}
                className="text-xs text-gray-500 hover:text-gray-700 transition"
              >
                Edit type
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-gray-100 border border-gray-200 text-gray-700 text-sm rounded-md px-3 py-1.5 w-48"
            />
            {selectedType && (
              <button
                onClick={() => { setEditingRecord(null); setShowRecordModal(true); }}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-md transition"
              >
                + Add Record
              </button>
            )}
          </div>
        </div>

        {selectedTypeObj && (
          <p className="text-sm text-gray-500">{selectedTypeObj.description}</p>
        )}

        {recordsLoading ? (
          <p className="text-gray-500 text-sm py-8">Loading...</p>
        ) : records.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-500">No records</p>
            {selectedType && (
              <p className="text-gray-500 text-sm mt-1">Add a record or let a workflow populate this type</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {records.map((record) => {
              const isExpanded = expandedRecord === record.id;
              const typeObj = types.find((t) => t.name === record.type);
              const fields = typeObj?.fields || [];

              return (
                <div
                  key={record.id}
                  className="bg-white border border-gray-200 rounded-lg overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedRecord(isExpanded ? null : record.id)}
                    className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-gray-100/50 transition"
                  >
                    {!selectedType && (
                      <span className="text-xs text-indigo-600 bg-indigo-100/30 px-2 py-0.5 rounded shrink-0">
                        {record.type}
                      </span>
                    )}
                    <span className="text-sm text-gray-900 truncate flex-1">
                      {summarizeRecord(record, fields)}
                    </span>
                    {record.attachments?.length > 0 && (
                      <span className="text-xs text-gray-500">
                        {record.attachments.length} file{record.attachments.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    <span className="text-xs text-gray-500 shrink-0">{timeAgo(record.updated_at)}</span>
                    <svg
                      className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-200 px-5 py-4 space-y-3">
                      {/* Data fields */}
                      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                        {Object.entries(record.data).map(([key, val]) => (
                          <div key={key}>
                            <span className="text-xs text-gray-500">{key}</span>
                            <div className="text-sm text-gray-900 break-words">
                              {val == null ? <span className="text-gray-500">-</span> : String(val)}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Attachments */}
                      {record.attachments?.length > 0 && (
                        <div className="space-y-1">
                          <span className="text-xs text-gray-500">Attachments</span>
                          {record.attachments.map((att) => (
                            <div key={att.s3_key} className="flex items-center gap-2">
                              <button
                                onClick={async () => {
                                  const { url } = await getAttachmentUrl(record.id, att.s3_key);
                                  window.open(url, "_blank");
                                }}
                                className="text-sm text-indigo-600 hover:text-indigo-500 transition"
                              >
                                {att.filename}
                              </button>
                              <span className="text-xs text-gray-500">{formatBytes(att.size_bytes)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Meta */}
                      <div className="flex items-center gap-4 text-xs text-gray-500 pt-2 border-t border-gray-200">
                        <span>Created by: {record.created_by}</span>
                        <span>Created: {new Date(record.created_at).toLocaleDateString()}</span>
                        <div className="ml-auto flex gap-2">
                          <button
                            onClick={() => { setEditingRecord(record); setShowRecordModal(true); }}
                            className="text-gray-600 hover:text-gray-900 transition"
                          >
                            Edit
                          </button>
                          <button
                            onClick={async () => {
                              await deleteKnowledgeRecord(record.id);
                              loadRecords(selectedType, search);
                              loadTypes();
                            }}
                            className="text-red-500 hover:text-red-700 transition"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Type modal */}
      {showTypeModal && (
        <TypeModal
          type={editingType}
          onClose={() => setShowTypeModal(false)}
          onSave={async (data) => {
            if (editingType) {
              await updateKnowledgeType(editingType.id, data);
            } else {
              await createKnowledgeType(data as any);
            }
            setShowTypeModal(false);
            loadTypes();
          }}
          onDelete={editingType ? async () => {
            await deleteKnowledgeType(editingType.id);
            setShowTypeModal(false);
            if (selectedType === editingType.name) setSelectedType(null);
            loadTypes();
          } : undefined}
        />
      )}

      {/* Record modal */}
      {showRecordModal && selectedTypeObj && (
        <RecordModal
          type={selectedTypeObj}
          record={editingRecord}
          onClose={() => setShowRecordModal(false)}
          onSave={async (data) => {
            if (editingRecord) {
              await updateKnowledgeRecord(editingRecord.id, { data });
            } else {
              await createKnowledgeRecord({ type: selectedTypeObj.name, data, created_by: "manual" });
            }
            setShowRecordModal(false);
            loadRecords(selectedType, search);
            loadTypes();
          }}
        />
      )}
    </div>
  );
}

function summarizeRecord(record: KnowledgeRecord, fields: KnowledgeTypeField[]): string {
  // Try to build a summary from the first 2-3 meaningful fields
  const parts: string[] = [];
  const tryKeys = fields.length > 0
    ? fields.slice(0, 3).map((f) => f.name)
    : Object.keys(record.data).slice(0, 3);
  for (const k of tryKeys) {
    const v = record.data[k];
    if (v != null && v !== "") parts.push(String(v));
  }
  return parts.join(" - ") || record.id;
}

// ---- Type Modal ----

function TypeModal({ type, onClose, onSave, onDelete }: {
  type: KnowledgeType | null;
  onClose: () => void;
  onSave: (data: Partial<KnowledgeType>) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(type?.name || "");
  const [label, setLabel] = useState(type?.label || "");
  const [description, setDescription] = useState(type?.description || "");
  const [fields, setFields] = useState<KnowledgeTypeField[]>(type?.fields || []);
  const [saving, setSaving] = useState(false);

  const addField = () => setFields([...fields, { name: "", type: "string" }]);
  const removeField = (i: number) => setFields(fields.filter((_, j) => j !== i));
  const updateField = (i: number, updates: Partial<KnowledgeTypeField>) =>
    setFields(fields.map((f, j) => j === i ? { ...f, ...updates } : f));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white border border-gray-200 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{type ? "Edit Type" : "New Type"}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900 transition text-xl">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          <div>
            <label className="text-xs text-gray-500">Name (slug)</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              disabled={!!type}
              className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-sm rounded-md px-3 py-2 mt-1 disabled:opacity-50"
              placeholder="signed_contract"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Label</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-sm rounded-md px-3 py-2 mt-1"
              placeholder="Signed Contracts"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-sm rounded-md px-3 py-2 mt-1"
              placeholder="Executed hotel contracts with final amounts"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-500">Fields</label>
              <button onClick={addField} className="text-xs text-indigo-600 hover:text-indigo-500">+ Add field</button>
            </div>
            <div className="space-y-2 mt-2">
              {fields.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={f.name}
                    onChange={(e) => updateField(i, { name: e.target.value })}
                    className="flex-1 bg-gray-100 border border-gray-200 text-gray-900 text-xs rounded px-2 py-1.5"
                    placeholder="field_name"
                  />
                  <select
                    value={f.type}
                    onChange={(e) => updateField(i, { type: e.target.value as any })}
                    className="bg-gray-100 border border-gray-200 text-gray-700 text-xs rounded px-2 py-1.5"
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="date">date</option>
                    <option value="boolean">boolean</option>
                    <option value="attachment">attachment</option>
                    <option value="select">select</option>
                    <option value="multi_select">multi_select</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={f.required || false}
                      onChange={(e) => updateField(i, { required: e.target.checked })}
                    />
                    req
                  </label>
                  <button onClick={() => removeField(i)} className="text-red-500 text-xs hover:text-red-700">x</button>
                  {(f.type === "select" || f.type === "multi_select") && (
                    <input
                      value={(f.options || []).join(", ")}
                      onChange={(e) => updateField(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                      className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-xs rounded px-2 py-1.5 mt-1"
                      placeholder="Option1, Option2, Option3"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200">
          <div>
            {onDelete && (
              <button
                onClick={onDelete}
                className="text-xs text-red-500 hover:text-red-700 transition"
              >
                Delete type + all records
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 transition">Cancel</button>
            <button
              onClick={async () => {
                setSaving(true);
                await onSave({ name, label, description, fields });
                setSaving(false);
              }}
              disabled={saving || !name || !label}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-md transition"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Record Modal ----

function RecordModal({ type, record, onClose, onSave }: {
  type: KnowledgeType;
  record: KnowledgeRecord | null;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
}) {
  const [data, setData] = useState<Record<string, any>>(record?.data || {});
  const [saving, setSaving] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);

  const updateField = (name: string, value: any) => setData({ ...data, [name]: value });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white border border-gray-200 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{record ? "Edit Record" : "New Record"}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900 transition text-xl">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
          {type.fields.map((field) => (
            <div key={field.name}>
              <label className="text-xs text-gray-500">
                {field.name}
                {field.required && <span className="text-red-700 ml-1">*</span>}
                <span className="text-gray-500 ml-1">({field.type})</span>
              </label>
              {field.type === "boolean" ? (
                <div className="mt-1">
                  <input
                    type="checkbox"
                    checked={!!data[field.name]}
                    onChange={(e) => updateField(field.name, e.target.checked)}
                  />
                </div>
              ) : field.type === "select" && field.options ? (
                <select
                  value={data[field.name] ?? ""}
                  onChange={(e) => updateField(field.name, e.target.value || undefined)}
                  className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-sm rounded-md px-3 py-2 mt-1"
                >
                  <option value="">—</option>
                  {field.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : field.type === "multi_select" && field.options ? (
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {field.options.map((opt) => {
                    const selected = (data[field.name] || []).includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          const current: string[] = data[field.name] || [];
                          updateField(field.name, selected ? current.filter((v: string) => v !== opt) : [...current, opt]);
                        }}
                        className={`px-2 py-1 text-xs rounded-md border transition ${
                          selected
                            ? "bg-indigo-600/30 border-indigo-500 text-indigo-500"
                            : "bg-gray-100 border-gray-200 text-gray-600 hover:text-gray-900"
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              ) : field.type === "attachment" && record ? (
                <div className="mt-1">
                  <input
                    type="file"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !record) return;
                      setUploadingFile(true);
                      try {
                        await uploadKnowledgeAttachment(record.id, file);
                      } finally {
                        setUploadingFile(false);
                      }
                    }}
                    className="text-sm text-gray-600"
                  />
                  {uploadingFile && <span className="text-xs text-gray-500 ml-2">Uploading...</span>}
                </div>
              ) : (
                <input
                  type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                  value={data[field.name] ?? ""}
                  onChange={(e) => updateField(field.name, field.type === "number" ? Number(e.target.value) : e.target.value)}
                  className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-sm rounded-md px-3 py-2 mt-1"
                />
              )}
            </div>
          ))}

          {/* Extra fields not in schema */}
          {Object.keys(data).filter((k) => !type.fields.find((f) => f.name === k)).map((key) => (
            <div key={key}>
              <label className="text-xs text-gray-500">{key} <span className="text-gray-500">(extra)</span></label>
              <input
                value={data[key] ?? ""}
                onChange={(e) => updateField(key, e.target.value)}
                className="w-full bg-gray-100 border border-gray-200 text-gray-900 text-sm rounded-md px-3 py-2 mt-1"
              />
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
          <button onClick={onClose} className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 transition">Cancel</button>
          <button
            onClick={async () => {
              setSaving(true);
              await onSave(data);
              setSaving(false);
            }}
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-md transition"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
