import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getWorkflow, createWorkflow, updateWorkflow, listSlackChannels, listConnections, previewListCount, listKnowledgeTypes, type WorkflowCreate, type SlackChannel, type Connection, type SkipCondition, type KnowledgeType } from "../api";

const EMPTY: WorkflowCreate = {
  name: "",
  enabled: true,
  trigger_type: "manual",
  trigger_config: {},
  list_source: null,
  list_config: {},
  ai_filter_prompt: null,
  skip_condition: null,
  action_prompt: "",
  action_model: "claude-opus-4-6",
  action_effort: "high",
  action_mode: "staged",
  auto_execute_actions: null,
  memory_dir: null,
  slack_notify_channel: null,
  slack_notify_detail: false,
  slack_notify_header: null,
  slack_notify_skip_noaction: true,
  slack_action_channel: null,
};

export default function WorkflowEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<WorkflowCreate>({ ...EMPTY });
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewItems, setPreviewItems] = useState<Record<string, any>[] | null>(null);
  const [previewingItems, setPreviewingItems] = useState(false);
  const [knowledgeTypes, setKnowledgeTypes] = useState<KnowledgeType[]>([]);
  const [copied, setCopied] = useState(false);

  const isConnected = (service: string) => connections.some((c) => c.service === service);

  useEffect(() => {
    listSlackChannels().then(setChannels).catch(() => {});
    listConnections().then(setConnections).catch(() => {});
    listKnowledgeTypes().then(setKnowledgeTypes).catch(() => {});
    if (id) {
      getWorkflow(id).then((w) => {
        const { id: _, created_at: _c, updated_at: _u, ...rest } = w;
        setForm(rest);
        setLoading(false);
      });
    }
  }, [id]);

  const set = <K extends keyof WorkflowCreate>(key: K, value: WorkflowCreate[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setConfig = (key: "trigger_config" | "list_config", field: string, value: string | undefined) =>
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  const save = async () => {
    setSaving(true);
    try {
      if (isEdit && id) {
        await updateWorkflow(id, form);
      } else {
        await createWorkflow(form);
      }
      navigate("/");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-gray-500">Loading...</p>;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="text-xl font-semibold text-gray-900">
        {isEdit ? "Edit Workflow" : "New Workflow"}
      </h1>

      {/* Name */}
      <Field label="Name">
        <input
          type="text"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Forward CVB Emails"
          className="input"
        />
      </Field>

      {/* Step 1: Trigger */}
      <Step number={1} title="Trigger" description="When should this workflow run?">
        <Field label="Type">
          <select
            value={form.trigger_type}
            onChange={(e) => set("trigger_type", e.target.value as any)}
            className="input"
          >
            <option value="manual">Manual</option>
            <option value="cron">Cron Schedule</option>
            <option value="slack_message">Slack Message</option>
            <option value="gmail_poll">Gmail Poll</option>
          </select>
        </Field>

        {form.trigger_type === "cron" && (
          <CronPicker
            value={form.trigger_config.cron ?? "0 9 * * *"}
            onChange={(cron) => setConfig("trigger_config", "cron", cron)}
          />
        )}

        {form.trigger_type === "slack_message" && (() => {
          const selected: string[] = form.trigger_config.channels ?? (form.trigger_config.channel ? [form.trigger_config.channel] : []);
          const isAny = selected.includes("*");
          const toggle = (id: string) => {
            const next = selected.includes(id) ? selected.filter((c) => c !== id) : [...selected.filter((c) => c !== "*"), id];
            setForm((prev) => ({ ...prev, trigger_config: { ...prev.trigger_config, channels: next, channel: undefined } }));
          };
          const setAny = (any: boolean) => {
            setForm((prev) => ({ ...prev, trigger_config: { ...prev.trigger_config, channels: any ? ["*"] : [], channel: undefined } }));
          };
          return (
            <Field label="Channels">
              <label className="flex items-center gap-2 mb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAny}
                  onChange={(e) => setAny(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
                />
                <span className="text-sm text-gray-700">Any channel</span>
              </label>
              {!isAny && (
                <div className="max-h-40 overflow-y-auto space-y-1 border border-gray-200 rounded-md p-2 bg-white">
                  {channels.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.includes(c.id)}
                        onChange={() => toggle(c.id)}
                        className="w-3.5 h-3.5 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-gray-700">#{c.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          );
        })()}

        {form.trigger_type === "gmail_poll" && (
          <>
            <ConnectionWarning service="Gmail" connected={isConnected("gmail")} />
            <GmailQueryBuilder
              value={form.trigger_config.query ?? ""}
              onChange={(q) => setConfig("trigger_config", "query", q)}
            />
          </>
        )}
      </Step>

      {/* Step 2: List */}
      <Step number={2} title="List" description="What items should the agent process?">
        <Field label="Source">
          <select
            value={form.list_source ?? ""}
            onChange={(e) => set("list_source", (e.target.value || null) as any)}
            className="input"
          >
            <option value="">None (trigger data only)</option>
            <option value="ai">AI (describe what to fetch)</option>
            <option value="supabase">Supabase</option>
            <option value="airtable">Airtable</option>
            <option value="gmail">Gmail</option>
            <option value="slack">Slack</option>
          </select>
        </Field>

        {form.list_source === "ai" && (
          <Field label="Describe the list">
            <textarea
              value={form.list_config.prompt ?? ""}
              onChange={(e) => setConfig("list_config", "prompt", e.target.value)}
              placeholder="e.g. Find all hotel email threads where we haven't gotten a response in 3+ days. Include the thread ID, hotel name, contact email, subject, and last message date."
              rows={4}
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              An AI agent with your MCP tools will figure out the list. Describe what items you want and what data to include for each.
            </p>
          </Field>
        )}

        {form.list_source === "supabase" && (
          <>
            <Field label="Schema">
              <input
                type="text"
                value={form.list_config.schema ?? ""}
                onChange={(e) => setConfig("list_config", "schema", e.target.value || undefined)}
                placeholder="public"
                className="input"
              />
            </Field>
            <Field label="Table">
              <input
                type="text"
                value={form.list_config.table ?? ""}
                onChange={(e) => setConfig("list_config", "table", e.target.value)}
                placeholder="events"
                className="input"
              />
            </Field>
            <Field label="Select (columns)">
              <input
                type="text"
                value={form.list_config.select ?? ""}
                onChange={(e) => setConfig("list_config", "select", e.target.value || undefined)}
                placeholder="event_id,name,status"
                className="input"
              />
            </Field>
            <Field label="Filter (PostgREST params)">
              <input
                type="text"
                value={form.list_config.filter ?? (form.list_config.filters ? Object.entries(form.list_config.filters).map(([k, v]) => `${k}=${v}`).join("&") : "")}
                onChange={(e) => {
                  setConfig("list_config", "filter", e.target.value);
                  // Clear legacy filters object when editing string filter
                  if (form.list_config.filters) {
                    setForm((prev) => ({
                      ...prev,
                      list_config: { ...prev.list_config, filters: undefined, filter: e.target.value },
                    }));
                  }
                }}
                placeholder='internal_status=in.(done_sourcing,canceled)'
                className="input"
              />
            </Field>
            <Field label="Order">
              <input
                type="text"
                value={form.list_config.order ?? ""}
                onChange={(e) => setConfig("list_config", "order", e.target.value || undefined)}
                placeholder="event_id.desc"
                className="input"
              />
            </Field>
          </>
        )}

        {form.list_source === "airtable" && (
          <>
            <Field label="Base ID">
              <input
                type="text"
                value={form.list_config.base_id ?? ""}
                onChange={(e) => setConfig("list_config", "base_id", e.target.value)}
                placeholder="appXXXXXXXX"
                className="input"
              />
            </Field>
            <Field label="Table">
              <input
                type="text"
                value={form.list_config.table ?? ""}
                onChange={(e) => setConfig("list_config", "table", e.target.value)}
                placeholder="Contacts"
                className="input"
              />
            </Field>
          </>
        )}

        {form.list_source === "gmail" && (
          <>
            <ConnectionWarning service="Gmail" connected={isConnected("gmail")} />
            <GmailQueryBuilder
              value={form.list_config.query ?? ""}
              onChange={(q) => setConfig("list_config", "query", q)}
            />
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.list_config.group_by_thread === true || form.list_config.group_by_thread === "true"}
                onChange={(e) => setForm((prev) => ({
                  ...prev,
                  list_config: { ...prev.list_config, group_by_thread: e.target.checked },
                }))}
                className="w-4 h-4 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
              />
              <div>
                <span className="text-xs text-gray-700">Group by thread</span>
                <p className="text-xs text-gray-500">
                  One item per conversation thread instead of one per email. Includes full thread history.
                </p>
              </div>
            </label>
          </>
        )}

        {form.list_source === "slack" && (
          <Field label="Channel">
            <select
              value={form.list_config.channel ?? ""}
              onChange={(e) => setConfig("list_config", "channel", e.target.value)}
              className="input"
            >
              <option value="">Select a channel...</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </Field>
        )}

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.ai_filter_prompt !== null}
              onChange={(e) => set("ai_filter_prompt", e.target.checked ? "" : null)}
              className="w-4 h-4 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-xs text-gray-600">Enable AI Filter</span>
          </label>
          {form.ai_filter_prompt !== null && (
            <>
            <p className="text-xs text-gray-500 mt-2">
              Each item is evaluated individually using Haiku. The AI only sees the item data — no other context.
            </p>
            <textarea
              value={form.ai_filter_prompt ?? ""}
              onChange={(e) => set("ai_filter_prompt", e.target.value || null)}
              placeholder='e.g. "Only include emails that mention commissionable rates or group bookings"'
              className="input min-h-[80px] mt-1"
            />
            </>
          )}
        </div>

        {/* Skip Conditions */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.skip_condition !== null}
              onChange={(e) =>
                set(
                  "skip_condition",
                  e.target.checked
                    ? [{ source: "knowledge", knowledge_type: "", match: [{ item_field: "", record_field: "" }], where: {} }]
                    : null
                )
              }
              className="w-4 h-4 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-xs text-gray-600">Skip conditions</span>
          </label>
          {form.skip_condition && (() => {
            const conditions: SkipCondition[] = Array.isArray(form.skip_condition) ? form.skip_condition : [form.skip_condition!];
            const setConditions = (next: SkipCondition[]) => set("skip_condition", next.length ? next : null);
            const updateAt = (idx: number, patch: Partial<SkipCondition>) => {
              const next = [...conditions];
              next[idx] = { ...next[idx], ...patch };
              setConditions(next);
            };
            const removeAt = (idx: number) => setConditions(conditions.filter((_, i) => i !== idx));
            const addCondition = () => setConditions([...conditions, { source: "knowledge", knowledge_type: "", match: [{ item_field: "", record_field: "" }], where: {} }]);
            return (
              <div className="mt-2 space-y-4">
                {conditions.map((sc, ci) => (
                  <div key={ci} className="space-y-3 pl-6 border-l border-gray-200">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-500">
                        {sc.source === "no_external_reply"
                          ? "Skip threads where someone external has replied."
                          : sc.source === "max_messages"
                          ? "Skip threads with more than N messages."
                          : sc.source === "recent_activity"
                          ? "Skip threads where the most recent message is too recent."
                          : "Skip items that already have a matching record. Zero AI cost."}
                      </p>
                      {conditions.length > 1 && (
                        <button type="button" onClick={() => removeAt(ci)} className="text-gray-500 hover:text-red-700 text-xs ml-2">✕</button>
                      )}
                    </div>
                    <div className="flex gap-2 items-center">
                      <span className="text-xs text-gray-500 w-14">Source</span>
                      <select
                        value={sc.source}
                        onChange={(e) => updateAt(ci, { source: e.target.value as SkipCondition["source"], max_messages: undefined, min_age_minutes: undefined })}
                        className="input text-xs flex-1"
                      >
                        <option value="knowledge">Knowledge DB</option>
                        <option value="supabase">Supabase</option>
                        <option value="no_external_reply">No external reply (email threads)</option>
                        <option value="max_messages">Max message count</option>
                        <option value="recent_activity">Skip recent activity</option>
                      </select>
                    </div>
                    {sc.source === "no_external_reply" ? (
                      <p className="text-xs text-gray-500">No additional config needed. Skips threads where any non-you, non-bounce sender has replied.</p>
                    ) : sc.source === "max_messages" ? (
                      <div className="flex gap-2 items-center">
                        <span className="text-xs text-gray-500 w-14">Max</span>
                        <input
                          type="number"
                          min={1}
                          value={sc.max_messages ?? 4}
                          onChange={(e) => updateAt(ci, { max_messages: parseInt(e.target.value) || 4 })}
                          className="input text-xs w-20"
                        />
                        <span className="text-xs text-gray-500">messages</span>
                      </div>
                    ) : sc.source === "recent_activity" ? (
                      <div className="flex gap-2 items-center">
                        <span className="text-xs text-gray-500 w-14">Min age</span>
                        <input
                          type="number"
                          min={1}
                          value={sc.min_age_minutes ?? 1440}
                          onChange={(e) => updateAt(ci, { min_age_minutes: parseInt(e.target.value) || 1440 })}
                          className="input text-xs w-24"
                        />
                        <span className="text-xs text-gray-500">minutes ({Math.round((sc.min_age_minutes ?? 1440) / 60 * 10) / 10}h)</span>
                      </div>
                    ) : sc.source === "knowledge" ? (
                      <div className="flex gap-2 items-center">
                        <span className="text-xs text-gray-500 w-14">Type</span>
                        <select
                          value={sc.knowledge_type ?? ""}
                          onChange={(e) => updateAt(ci, { knowledge_type: e.target.value })}
                          className="input text-xs flex-1"
                        >
                          <option value="">Select type...</option>
                          {knowledgeTypes.map((kt) => (
                            <option key={kt.id} value={kt.name}>{kt.label || kt.name}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex gap-2 items-center">
                          <span className="text-xs text-gray-500 w-14">Table</span>
                          <input value={sc.table ?? ""} onChange={(e) => updateAt(ci, { table: e.target.value })} className="input text-xs flex-1" placeholder="e.g. events" />
                        </div>
                        <div className="flex gap-2 items-center">
                          <span className="text-xs text-gray-500 w-14">Schema</span>
                          <input value={sc.schema ?? ""} onChange={(e) => updateAt(ci, { schema: e.target.value || undefined })} className="input text-xs flex-1" placeholder="e.g. nowadays (optional)" />
                        </div>
                      </div>
                    )}
                    {sc.source !== "no_external_reply" && sc.source !== "max_messages" && sc.source !== "recent_activity" && <div>
                      <span className="text-xs text-gray-500">Match fields</span>
                      {sc.match.map((m, i) => (
                        <div key={i} className="flex gap-2 items-center mt-1">
                          <input
                            value={m.item_field}
                            onChange={(e) => {
                              const match = [...sc.match];
                              match[i] = { ...match[i], item_field: e.target.value };
                              updateAt(ci, { match });
                            }}
                            className="input text-xs flex-1"
                            placeholder="Item field"
                          />
                          <span className="text-xs text-gray-500">=</span>
                          <input
                            value={m.record_field}
                            onChange={(e) => {
                              const match = [...sc.match];
                              match[i] = { ...match[i], record_field: e.target.value };
                              updateAt(ci, { match });
                            }}
                            className="input text-xs flex-1"
                            placeholder="Record field"
                          />
                          {sc.match.length > 1 && (
                            <button type="button" onClick={() => updateAt(ci, { match: sc.match.filter((_, j) => j !== i) })} className="text-gray-500 hover:text-red-700 text-xs">✕</button>
                          )}
                        </div>
                      ))}
                      <button type="button" onClick={() => updateAt(ci, { match: [...sc.match, { item_field: "", record_field: "" }] })} className="text-xs text-indigo-600 hover:text-indigo-500 mt-1">+ Add match</button>
                    </div>}
                    {sc.source !== "no_external_reply" && sc.source !== "max_messages" && sc.source !== "recent_activity" && <div>
                      <span className="text-xs text-gray-500">Where filters (optional)</span>
                      {Object.entries(sc.where ?? {}).map(([field, value], i) => (
                        <div key={i} className="flex gap-2 items-center mt-1">
                          <input
                            value={field}
                            onChange={(e) => {
                              const where = { ...sc.where };
                              const val = where[field];
                              delete where[field];
                              where[e.target.value] = val;
                              updateAt(ci, { where });
                            }}
                            className="input text-xs flex-1"
                            placeholder="Field"
                          />
                          <span className="text-xs text-gray-500">=</span>
                          <input
                            value={value}
                            onChange={(e) => updateAt(ci, { where: { ...sc.where, [field]: e.target.value } })}
                            className="input text-xs flex-1"
                            placeholder="Value"
                          />
                          <button type="button" onClick={() => {
                            const where = { ...sc.where };
                            delete where[field];
                            updateAt(ci, { where });
                          }} className="text-gray-500 hover:text-red-700 text-xs">✕</button>
                        </div>
                      ))}
                      <button type="button" onClick={() => updateAt(ci, { where: { ...sc.where, "": "" } })} className="text-xs text-indigo-600 hover:text-indigo-500 mt-1">+ Add filter</button>
                    </div>}
                  </div>
                ))}
                <button type="button" onClick={addCondition} className="text-xs text-indigo-600 hover:text-indigo-500">+ Add skip condition</button>
              </div>
            );
          })()}
        </div>

        {form.list_source && form.list_source !== "ai" && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={previewing}
              onClick={async () => {
                setPreviewing(true);
                setPreviewCount(null);
                setPreviewError(null);
                try {
                  const { count } = await previewListCount(form.list_source!, form.list_config, false, form.skip_condition);
                  setPreviewCount(count);
                } catch (err: any) {
                  setPreviewError(err.message || "Failed to fetch");
                } finally {
                  setPreviewing(false);
                }
              }}
              className="text-xs bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 px-3 py-1.5 rounded-md transition"
            >
              {previewing ? "Checking..." : "Preview list count"}
            </button>
            {previewCount !== null && (
              <>
                <span className="text-xs text-gray-600">
                  {previewCount} item{previewCount !== 1 ? "s" : ""} found
                </span>
                <button
                  type="button"
                  disabled={previewingItems}
                  onClick={async () => {
                    setPreviewingItems(true);
                    try {
                      const { items } = await previewListCount(form.list_source!, form.list_config, true, form.skip_condition);
                      setPreviewItems(items ?? []);
                    } catch {}
                    finally { setPreviewingItems(false); }
                  }}
                  className="text-xs text-indigo-600 hover:text-indigo-500 disabled:opacity-50 transition"
                >
                  {previewingItems ? "Loading..." : "Show first 5"}
                </button>
              </>
            )}
            {previewError && (
              <span className="text-xs text-red-700">{previewError}</span>
            )}
          </div>
        )}
        {previewItems && previewItems.length > 0 && (
          <div className="mt-2 space-y-1">
            {previewItems.map((item, i) => (
              <div key={i} className="text-xs bg-gray-100 rounded px-3 py-2 text-gray-700">
                {item.subject || item.name || item.title || JSON.stringify(item).slice(0, 150)}
              </div>
            ))}
          </div>
        )}
      </Step>

      {/* Step 3: Action */}
      <Step number={3} title="Action" description="What should the agent do with each item?">
        <Field label="Action Prompt">
          <textarea
            value={form.action_prompt}
            onChange={(e) => set("action_prompt", e.target.value)}
            placeholder="For each item, find the relevant CVB contact and forward the email to them..."
            className="input min-h-[120px]"
          />
        </Field>

        <Field label="Model">
          <select
            value={form.action_model}
            onChange={(e) => set("action_model", e.target.value as any)}
            className="input"
          >
            <option value="claude-opus-4-6">Opus (most capable)</option>
            <option value="claude-sonnet-4-6">Sonnet (balanced)</option>
            <option value="claude-haiku-4-5">Haiku (fastest / cheapest)</option>
          </select>
        </Field>

        <Field label="Thinking effort">
          <select
            value={form.action_effort ?? "high"}
            onChange={(e) => set("action_effort", e.target.value as any)}
            className="input"
          >
            <option value="max">Max (most deliberate)</option>
            <option value="high">High (default)</option>
            <option value="medium">Medium</option>
            <option value="low">Low (fastest)</option>
          </select>
        </Field>

        <Field label="Memory directory (blank = shared default)">
          <input
            value={form.memory_dir ?? ""}
            onChange={(e) => set("memory_dir", e.target.value || null)}
            placeholder="memory/"
            className="input"
          />
        </Field>

        <label className="flex items-center gap-3 cursor-pointer">
          <button
            type="button"
            onClick={() => set("action_mode", form.action_mode === "auto" ? "staged" : "auto")}
            className={`w-10 h-5 rounded-full relative transition ${
              form.action_mode === "auto" ? "bg-green-600" : "bg-gray-200"
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                form.action_mode === "auto" ? "left-5" : "left-0.5"
              }`}
            />
          </button>
          <div>
            <span className="text-sm text-gray-900">Auto-execute</span>
            <p className="text-xs text-gray-500">
              {form.action_mode === "auto"
                ? "Agent will execute actions immediately"
                : "Actions staged for approval before executing"}
            </p>
          </div>
        </label>

        {form.action_mode === "auto" && (
          <div className="ml-13 space-y-2">
            <label className="text-xs text-gray-500">
              Only auto-execute these action types (leave empty for all)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {["send_email", "reply_email", "forward_email", "send_slack", "knowledge_upsert", "custom"].map((action) => {
                const selected = (form.auto_execute_actions || []).includes(action);
                return (
                  <button
                    key={action}
                    type="button"
                    onClick={() => {
                      const current = form.auto_execute_actions || [];
                      const next = selected
                        ? current.filter((a) => a !== action)
                        : [...current, action];
                      set("auto_execute_actions", next.length > 0 ? next : null);
                    }}
                    className={`px-2.5 py-1 text-xs rounded-md border transition ${
                      selected
                        ? "bg-green-600/30 border-green-500 text-green-600"
                        : "bg-gray-100 border-gray-200 text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    {action}
                  </button>
                );
              })}
            </div>
            {form.auto_execute_actions && (
              <p className="text-xs text-gray-500">
                Other actions will be staged for approval
              </p>
            )}
          </div>
        )}

        <Field label="Slack Notify Channel (optional)">
          <select
            value={form.slack_notify_channel ?? ""}
            onChange={(e) => set("slack_notify_channel", e.target.value || null)}
            className="input"
          >
            <option value="">None</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </Field>

        {form.slack_notify_channel && (<>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.slack_notify_detail === true}
              onChange={(e) => set("slack_notify_detail", e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
            />
            <div>
              <span className="text-xs text-gray-700">Show action details in notification</span>
              <p className="text-xs text-gray-500">
                Include the full action summary for every item, not just single-item runs.
              </p>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.slack_notify_skip_noaction !== false}
              onChange={(e) => set("slack_notify_skip_noaction", e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 bg-white text-indigo-500 focus:ring-indigo-500"
            />
            <div>
              <span className="text-xs text-gray-700">Skip notification if all items are no-action</span>
              <p className="text-xs text-gray-500">
                Don't send any Slack messages when every item results in "no action needed."
              </p>
            </div>
          </label>

          <Field label="Notification header (optional)">
            <input
              type="text"
              value={form.slack_notify_header ?? ""}
              onChange={(e) => set("slack_notify_header", e.target.value || null)}
              placeholder="e.g. Finance Tracker Daily Update"
              className="input"
            />
          </Field>
        </>)}

        <Field label="Action Executed Notification Channel (optional)">
          <select
            value={form.slack_action_channel ?? ""}
            onChange={(e) => set("slack_action_channel", e.target.value || null)}
            className="input"
          >
            <option value="">None</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>#{ch.name}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Notify this channel when actions are approved or auto-executed (separate from staging notifications above).
          </p>
        </Field>
      </Step>

      <div className="flex gap-3 pt-2">
        <button
          onClick={save}
          disabled={saving || !form.name || !form.action_prompt}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-6 py-2 rounded-md transition"
        >
          {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Workflow"}
        </button>
        <button
          onClick={() => navigate("/")}
          className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm px-6 py-2 rounded-md transition"
        >
          Cancel
        </button>
        {isEdit && (
          <button
            type="button"
            onClick={() => {
              const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              const nl2br = (s: string) => esc(s).replace(/\n/g, "<br>");

              // Build HTML
              const h: string[] = [];
              h.push(`<h1 style="font-size:24px;font-weight:bold">${esc(form.name)}</h1>`);

              // Action prompt
              h.push(`<h2 style="font-size:18px;font-weight:bold;margin-top:16px">Action Prompt</h2>`);
              h.push(`<p style="white-space:pre-wrap">${nl2br(form.action_prompt)}</p>`);

              // Details
              h.push(`<hr style="margin:20px 0">`);
              h.push(`<h2 style="font-size:16px;font-weight:bold;margin-top:16px"><i>Details</i></h2>`);
              h.push(`<p style="color:#666;font-style:italic;font-size:14px">This part just describes when or for what things this action should happen — it can watch for things from Slack/email/database, or just execute every X hours, and its actions can be anything in Slack/email/database.</p>`);

              // Trigger
              const triggerLabels: Record<string, string> = {
                manual: "Manual",
                cron: `Scheduled: ${describeCron(form.trigger_config.cron ?? "")}`,
                slack_message: "Slack message",
                gmail_poll: `Gmail poll: ${esc(form.trigger_config.query ?? "")}`,
              };
              const details: [string, string][] = [];
              details.push(["Trigger", triggerLabels[form.trigger_type] || form.trigger_type]);

              if (form.list_source) {
                if (form.list_source === "ai") {
                  details.push(["List", `AI — ${form.list_config.prompt ?? ""}`]);
                } else if (form.list_source === "supabase") {
                  const parts = [form.list_config.table ?? ""];
                  if (form.list_config.filter) parts.push(`filter: ${form.list_config.filter}`);
                  else if (form.list_config.filters) parts.push(`filter: ${Object.entries(form.list_config.filters).map(([k, v]) => `${k}=${v}`).join("&")}`);
                  details.push(["List", `Supabase: ${parts.join(", ")}`]);
                } else if (form.list_source === "gmail") {
                  details.push(["List", `Gmail — ${form.list_config.query ?? ""}`]);
                } else {
                  details.push(["List", form.list_source]);
                }
              }

              if (form.ai_filter_prompt) {
                details.push(["AI Filter", form.ai_filter_prompt]);
              }

              if (form.skip_condition) {
                const scs: SkipCondition[] = Array.isArray(form.skip_condition) ? form.skip_condition : [form.skip_condition];
                for (const sc of scs) {
                  if (sc.source === "no_external_reply") {
                    details.push(["Skip condition", "Skip threads with external replies"]);
                  } else if (sc.source === "max_messages") {
                    details.push(["Skip condition", `Skip threads with more than ${sc.max_messages ?? 4} messages`]);
                  } else if (sc.source === "recent_activity") {
                    const mins = sc.min_age_minutes ?? 1440;
                    details.push(["Skip condition", `Skip if latest message is under ${mins >= 60 ? `${Math.round(mins / 60 * 10) / 10}h` : `${mins}m`} old`]);
                  } else {
                    const matchStr = sc.match.map((m) => `${m.item_field} = ${m.record_field}`).join(", ");
                    details.push(["Skip if already processed", `${sc.source === "knowledge" ? sc.knowledge_type : sc.table} (${matchStr})`]);
                  }
                }
              }

              details.push(["Mode", form.action_mode === "auto" ? "Auto-execute" : "Staged for approval"]);
              details.push(["Model", form.action_model]);

              h.push(`<ul style="font-style:italic;font-size:14px;color:#444">`);
              for (const [label, value] of details) {
                h.push(`<li><b>${esc(label)}:</b> ${esc(value)}</li>`);
              }
              h.push(`</ul>`);

              const html = h.join("\n");
              const blob = new Blob([html], { type: "text/html" });
              navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm px-4 py-2 rounded-md transition ml-auto"
          >
            {copied ? "Copied!" : "Copy for Google Doc"}
          </button>
        )}
      </div>
    </div>
  );
}

function Step({ number, title, description, children }: {
  number: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center gap-3">
        <span className="w-7 h-7 rounded-full bg-indigo-600 text-white text-sm flex items-center justify-center font-medium">
          {number}
        </span>
        <div>
          <h2 className="font-medium text-gray-900 text-sm">{title}</h2>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
      </div>
      <div className="space-y-3 pl-10">{children}</div>
    </div>
  );
}

function ConnectionWarning({ service, connected }: { service: string; connected: boolean }) {
  if (connected) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-100/30 border border-amber-200/50 text-amber-700 text-xs">
      <span>&#9888;</span>
      <span>
        {service} is not connected.{" "}
        <a href="/connections" className="underline hover:text-amber-800">
          Connect in Settings
        </a>{" "}
        for this workflow to work.
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-gray-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

const PRESETS = [
  { label: "Every day", cron: "0 9 * * *" },
  { label: "Weekdays", cron: "0 9 * * 1-5" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "3x a day (9am, 1pm, 5pm)", cron: "0 9,13,17 * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Every Monday", cron: "0 9 * * 1" },
  { label: "Custom", cron: "" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: i === 0 ? "12 AM" : i < 12 ? `${i} AM` : i === 12 ? "12 PM" : `${i - 12} PM`,
}));

function CronPicker({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const isPreset = PRESETS.some((p) => p.cron === value);
  const [custom, setCustom] = useState(!isPreset);

  return (
    <div className="space-y-2">
      <Field label="Frequency">
        <select
          value={custom ? "" : value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(v);
            }
          }}
          className="input"
        >
          {PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      {!custom && value && !value.startsWith("*/") && value.split(" ")[1] !== "*" && (() => {
        const parts = value.split(" ");
        const hours = parts[1].split(",").map(Number);
        const updateHour = (idx: number, newHour: number) => {
          const next = [...hours];
          next[idx] = newHour;
          next.sort((a, b) => a - b);
          const newCron = `${parts[0]} ${next.join(",")} ${parts.slice(2).join(" ")}`;
          onChange(newCron);
        };
        const addHour = () => {
          const used = new Set(hours);
          const next = HOURS.find((h) => !used.has(h.value))?.value ?? 0;
          const all = [...hours, next].sort((a, b) => a - b);
          const newCron = `${parts[0]} ${all.join(",")} ${parts.slice(2).join(" ")}`;
          onChange(newCron);
        };
        const removeHour = (idx: number) => {
          if (hours.length <= 1) return;
          const next = hours.filter((_, i) => i !== idx);
          const newCron = `${parts[0]} ${next.join(",")} ${parts.slice(2).join(" ")}`;
          onChange(newCron);
        };
        return (
          <Field label="Time">
            <div className="flex flex-wrap items-center gap-2">
              {hours.map((h, i) => (
                <div key={i} className="flex items-center gap-1">
                  <select
                    value={h}
                    onChange={(e) => updateHour(i, parseInt(e.target.value))}
                    className="bg-gray-100 border border-gray-200 text-gray-900 text-xs rounded px-2 py-1 focus:outline-none focus:border-indigo-500"
                  >
                    {HOURS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {hours.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeHour(i)}
                      className="text-gray-500 hover:text-red-700 text-xs"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addHour}
                className="text-xs text-indigo-600 hover:text-indigo-500"
              >
                + Add time
              </button>
            </div>
          </Field>
        );
      })()}

      {custom && (
        <Field label="Cron Expression">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="input"
          />
          <p className="text-xs text-gray-500 mt-1">
            Format: minute hour day month weekday — e.g. "0 9 * * 1-5" = weekdays at 9am
          </p>
        </Field>
      )}

      <p className="text-xs text-gray-500">
        Schedule: <span className="text-gray-600">{describeCron(value)}</span>
      </p>
    </div>
  );
}

function describeCron(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour, _dom, _mon, dow] = parts;

  let time = "";
  if (hour === "*") {
    time = min === "0" ? "every hour" : `every hour at :${min.padStart(2, "0")}`;
  } else if (hour.includes(",")) {
    time = "at " + hour.split(",").map((h) => {
      const n = parseInt(h);
      return n === 0 ? "12 AM" : n < 12 ? `${n} AM` : n === 12 ? "12 PM" : `${n - 12} PM`;
    }).join(", ");
  } else if (min.startsWith("*/")) {
    return `every ${min.slice(2)} minutes`;
  } else {
    const n = parseInt(hour);
    time = "at " + (n === 0 ? "12 AM" : n < 12 ? `${n} AM` : n === 12 ? "12 PM" : `${n - 12} PM`);
  }

  const DAYS: Record<string, string> = {
    "*": "every day",
    "1-5": "weekdays",
    "0,6": "weekends",
    "1": "Monday", "2": "Tuesday", "3": "Wednesday",
    "4": "Thursday", "5": "Friday", "6": "Saturday", "0": "Sunday",
  };
  const days = DAYS[dow] ?? `days ${dow}`;

  return `${days}, ${time}`;
}

const DATE_RANGE_OPTIONS = [
  { label: "Last 24 hours", value: "newer_than:1d" },
  { label: "Last 3 days", value: "newer_than:3d" },
  { label: "Last 7 days", value: "newer_than:7d" },
  { label: "Last 14 days", value: "newer_than:14d" },
  { label: "Last 30 days", value: "newer_than:30d" },
  { label: "Any time", value: "" },
];

const STATUS_OPTIONS = [
  { label: "Any", value: "" },
  { label: "Unread only", value: "is:unread" },
  { label: "Starred", value: "is:starred" },
  { label: "Has attachment", value: "has:attachment" },
];

function parseGmailQuery(q: string): {
  from: string; to: string; subject: string; contains: string;
  dateRange: string; status: string; custom: string;
} {
  const parts = { from: "", to: "", subject: "", contains: "", dateRange: "", status: "", custom: "" };
  const remaining: string[] = [];

  for (const token of tokenizeQuery(q)) {
    if (token.startsWith("from:")) parts.from = token.slice(5);
    else if (token.startsWith("to:")) parts.to = token.slice(3);
    else if (token.startsWith("subject:")) parts.subject = token.slice(8);
    else if (token.startsWith("newer_than:")) parts.dateRange = token;
    else if (token === "is:unread" || token === "is:starred" || token === "has:attachment") parts.status = token;
    else remaining.push(token);
  }

  // Anything left is either a contains phrase or custom
  const leftover = remaining.join(" ");
  if (leftover) parts.contains = leftover;

  return parts;
}

function tokenizeQuery(q: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < q.length) {
    if (q[i] === " ") { i++; continue; }
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      if (end !== -1) { tokens.push(q.slice(i, end + 1)); i = end + 1; }
      else { tokens.push(q.slice(i)); break; }
    } else {
      const end = q.indexOf(" ", i);
      if (end !== -1) { tokens.push(q.slice(i, end)); i = end + 1; }
      else { tokens.push(q.slice(i)); break; }
    }
  }
  return tokens;
}

function buildGmailQuery(parts: { from: string; to: string; subject: string; contains: string; dateRange: string; status: string }): string {
  const q: string[] = [];
  if (parts.from) q.push(`from:${parts.from}`);
  if (parts.to) q.push(`to:${parts.to}`);
  if (parts.subject) q.push(`subject:${parts.subject}`);
  if (parts.contains) {
    // Quote multi-word phrases
    const v = parts.contains.includes(" ") && !parts.contains.startsWith('"') ? `"${parts.contains}"` : parts.contains;
    q.push(v);
  }
  if (parts.dateRange) q.push(parts.dateRange);
  if (parts.status) q.push(parts.status);
  return q.join(" ");
}

function GmailQueryBuilder({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const parsed = parseGmailQuery(value);
  const [custom, setCustom] = useState(false);

  const update = (field: string, val: string) => {
    const next = { ...parsed, [field]: val };
    onChange(buildGmailQuery(next));
  };

  if (custom) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-600">Raw Gmail Query</span>
          <button type="button" onClick={() => setCustom(false)} className="text-xs text-indigo-600 hover:text-indigo-500">
            Use builder
          </button>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder='from:someone@example.com newer_than:7d "exact phrase"'
          className="input"
        />
        <p className="text-xs text-gray-500">
          Uses <a href="https://support.google.com/mail/answer/7190" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">Gmail search syntax</a>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-600">Gmail Filters</span>
        <button type="button" onClick={() => setCustom(true)} className="text-xs text-indigo-600 hover:text-indigo-500">
          Custom query
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <input
            type="text"
            value={parsed.from}
            onChange={(e) => update("from", e.target.value)}
            placeholder="sender@example.com"
            className="input"
          />
        </Field>
        <Field label="To">
          <input
            type="text"
            value={parsed.to}
            onChange={(e) => update("to", e.target.value)}
            placeholder="recipient@example.com"
            className="input"
          />
        </Field>
      </div>

      <Field label="Subject contains">
        <input
          type="text"
          value={parsed.subject}
          onChange={(e) => update("subject", e.target.value)}
          placeholder="Invoice"
          className="input"
        />
      </Field>

      <Field label="Body contains">
        <input
          type="text"
          value={parsed.contains}
          onChange={(e) => update("contains", e.target.value)}
          placeholder="commissionable rates"
          className="input"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date range">
          <select
            value={parsed.dateRange}
            onChange={(e) => update("dateRange", e.target.value)}
            className="input"
          >
            {DATE_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={parsed.status}
            onChange={(e) => update("status", e.target.value)}
            className="input"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {value && (
        <p className="text-xs text-gray-500">
          Query: <code className="text-gray-600 bg-white px-1 rounded">{value}</code>
        </p>
      )}
    </div>
  );
}
