import { useState } from "react";
import ReactMarkdown from "react-markdown";

export interface ParsedAction {
  action: string;
  [key: string]: any;
}

export function parseAgentResult(raw: string): { summary: string; actions: ParsedAction[] } {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      const actions: ParsedAction[] = Array.isArray(parsed) ? parsed : [parsed];
      const summary = raw.slice(0, raw.indexOf("```json")).trim();
      return { summary: summary || "Action plan ready.", actions };
    } catch {
      // fall through
    }
  }
  return { summary: raw, actions: [] };
}

export function ItemDataCard({ data }: { data: Record<string, any> }) {
  if (data.from && data.subject) {
    return (
      <div className="mt-2 bg-white rounded-lg p-4 space-y-2 text-sm">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <span className="text-gray-500">From</span>
          <span className="text-gray-900">{data.from}</span>
          {data.to && (
            <>
              <span className="text-gray-500">To</span>
              <span className="text-gray-900">{data.to}</span>
            </>
          )}
          <span className="text-gray-500">Subject</span>
          <span className="text-gray-900 font-medium">{data.subject}</span>
          {data.date && (
            <>
              <span className="text-gray-500">Date</span>
              <span className="text-gray-600 text-xs">{data.date}</span>
            </>
          )}
        </div>
        {data.body && (
          <details className="group">
            <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-600 transition">
              Email body
            </summary>
            <pre className="mt-1 text-xs text-gray-600 whitespace-pre-wrap max-h-60 overflow-y-auto">
              {data.body}
            </pre>
          </details>
        )}
        {data.snippet && !data.body && (
          <p className="text-xs text-gray-600 italic">{data.snippet}</p>
        )}
      </div>
    );
  }

  if (data.text && (data.channel || data.ts)) {
    return (
      <div className="mt-2 bg-white rounded-lg p-4 space-y-1 text-sm">
        {data.channel && (
          <div className="text-xs text-gray-500">
            Channel: <span className="font-mono text-gray-600">{data.channel}</span>
          </div>
        )}
        <p className="text-gray-700 whitespace-pre-wrap">{data.text}</p>
      </div>
    );
  }

  return (
    <pre className="mt-2 text-xs bg-white rounded p-3 overflow-x-auto text-gray-600 whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function AttachmentList({ attachments }: { attachments?: { filename: string; source?: string }[] }) {
  if (!attachments?.length) return null;
  return (
    <>
      <span className="text-gray-500">Files</span>
      <span className="text-gray-700 text-xs">
        {attachments.map((a, i) => (
          <span key={i}>{i > 0 && ", "}{a.filename}</span>
        ))}
      </span>
    </>
  );
}

function ReplyEmailCard({ action }: { action: ParsedAction }) {
  const [headers, setHeaders] = useState<{ resolved_to?: string; subject?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadHeaders = () => {
    if (headers || loading) return;
    setLoading(true);
    const url = action.message_id
      ? `/api/gmail/messages/${action.message_id}/headers`
      : `/api/gmail/threads/${action.thread_id}/headers`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => setHeaders(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const toDisplay = action.to?.length
    ? { value: Array.isArray(action.to) ? action.to.join(", ") : action.to, auto: false }
    : headers?.resolved_to
      ? { value: headers.resolved_to, auto: true }
      : null;

  const subject = headers?.subject;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-blue-700 text-lg">&#8617;</span>
        <span className="text-sm font-medium text-gray-900">Reply to Email</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <span className="text-gray-500">Thread</span>
        <span className="text-gray-900 font-mono text-xs">
          {action.thread_id}
          <a href={`https://mail.google.com/mail/u/0/#inbox/${action.thread_id}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 font-sans ml-2">open</a>
        </span>
        {toDisplay ? (
          <>
            <span className="text-gray-500">To</span>
            <span className="text-gray-900">{toDisplay.value}{toDisplay.auto && <span className="text-gray-500 text-xs ml-1">(auto)</span>}</span>
          </>
        ) : (
          <>
            <span className="text-gray-500">To</span>
            <span className="text-gray-600 text-xs">
              {loading ? "..." : <button onClick={loadHeaders} className="text-indigo-600 hover:text-indigo-500">load recipient</button>}
            </span>
          </>
        )}
        {subject && (
          <>
            <span className="text-gray-500">Subject</span>
            <span className="text-gray-900">{subject}</span>
          </>
        )}
        {action.cc?.length > 0 && (
          <>
            <span className="text-gray-500">Cc</span>
            <span className="text-gray-900">{Array.isArray(action.cc) ? action.cc.join(", ") : action.cc}</span>
          </>
        )}
        {action.bcc?.length > 0 && (
          <>
            <span className="text-gray-500">Bcc</span>
            <span className="text-gray-900">{Array.isArray(action.bcc) ? action.bcc.join(", ") : action.bcc}</span>
          </>
        )}
        <span className="text-gray-500">Body</span>
        <span className="text-gray-700 whitespace-pre-wrap">{action.body}</span>
        <AttachmentList attachments={action.attachments} />
      </div>
    </div>
  );
}

function ArchiveEmailCard({ action }: { action: ParsedAction }) {
  const [subject, setSubject] = useState<string | null>(action.thread_subject || null);
  const [loading, setLoading] = useState(false);

  const loadSubject = () => {
    if (subject || !action.thread_id || loading) return;
    setLoading(true);
    fetch(`/api/gmail/threads/${action.thread_id}/headers`)
      .then((r) => r.json())
      .then((data) => { if (data.subject) setSubject(data.subject); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-gray-600 text-lg">&#128230;</span>
        <span className="text-sm font-medium text-gray-900">Archive Email</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <span className="text-gray-500">Thread</span>
        <span className="text-gray-900">
          {subject || (
            <span className="font-mono text-xs">
              {action.thread_id}
              {!loading && <button onClick={loadSubject} className="text-indigo-600 hover:text-indigo-500 ml-2 font-sans">load</button>}
              {loading && <span className="text-gray-500 ml-2 font-sans">...</span>}
            </span>
          )}
          {action.thread_id && (
            <a href={`https://mail.google.com/mail/u/0/#inbox/${action.thread_id}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 text-xs ml-2">open</a>
          )}
        </span>
      </div>
    </div>
  );
}

export function ActionCard({ action }: { action: ParsedAction }) {
  switch (action.action) {
    case "send_email":
      return (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-blue-700 text-lg">&#9993;</span>
            <span className="text-sm font-medium text-gray-900">Send Email</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-gray-500">To</span>
            <span className="text-gray-900">{Array.isArray(action.to) ? action.to.join(", ") : action.to}</span>
            {action.cc?.length > 0 && (
              <>
                <span className="text-gray-500">Cc</span>
                <span className="text-gray-900">{Array.isArray(action.cc) ? action.cc.join(", ") : action.cc}</span>
              </>
            )}
            {action.bcc?.length > 0 && (
              <>
                <span className="text-gray-500">Bcc</span>
                <span className="text-gray-900">{Array.isArray(action.bcc) ? action.bcc.join(", ") : action.bcc}</span>
              </>
            )}
            <span className="text-gray-500">Subject</span>
            <span className="text-gray-900">{action.subject}</span>
            <span className="text-gray-500">Body</span>
            <span className="text-gray-700 whitespace-pre-wrap">{action.body}</span>
            <AttachmentList attachments={action.attachments} />
          </div>
        </div>
      );

    case "reply_email":
      return <ReplyEmailCard action={action} />;

    case "send_slack":
      return (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-purple-700 text-lg">#</span>
            <span className="text-sm font-medium text-gray-900">Send Slack Message</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-gray-500">Channel</span>
            <span className="text-gray-900 font-mono text-xs">{action.channel}</span>
            {action.thread_ts && (
              <>
                <span className="text-gray-500">Thread</span>
                <span className="text-gray-900 font-mono text-xs">{action.thread_ts}</span>
              </>
            )}
            <span className="text-gray-500">Message</span>
            <span className="text-gray-700 whitespace-pre-wrap">{action.text}</span>
            <AttachmentList attachments={action.attachments} />
          </div>
        </div>
      );

    case "custom":
      return (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-amber-700 text-lg">&#9998;</span>
            <span className="text-sm font-medium text-gray-900">Manual Action</span>
          </div>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{action.description}</p>
        </div>
      );

    case "none":
      return (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-lg">&#8709;</span>
            <span className="text-sm font-medium text-gray-600">No Action</span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{action.reason}</p>
        </div>
      );

    case "archive_email":
      return <ArchiveEmailCard action={action} />;

    case "knowledge_upsert":
      return (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-emerald-700 text-lg">&#128218;</span>
            <span className="text-sm font-medium text-gray-900">Knowledge Upsert</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-gray-500">Type</span>
            <span className="text-gray-900">{action.type}</span>
            <span className="text-gray-500">Match On</span>
            <span className="text-gray-900">{Array.isArray(action.match_on) ? action.match_on.join(", ") : JSON.stringify(action.match_on ?? "")}</span>
            <span className="text-gray-500">Data</span>
            <pre className="text-gray-700 text-xs whitespace-pre-wrap">{JSON.stringify(action.data, null, 2)}</pre>
          </div>
        </div>
      );

    default:
      return (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-sm text-gray-600 mb-1">Unknown action: {action.action}</div>
          <pre className="text-xs text-gray-500 whitespace-pre-wrap">
            {JSON.stringify(action, null, 2)}
          </pre>
        </div>
      );
  }
}

export function AgentResultDisplay({ agentResult }: { agentResult: string }) {
  const parsed = parseAgentResult(agentResult);

  return (
    <div className="space-y-3">
      {parsed.summary && (
        <div className="text-sm text-gray-700 prose prose-sm max-w-none">
          <ReactMarkdown>{parsed.summary}</ReactMarkdown>
        </div>
      )}

      {parsed.actions.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 uppercase tracking-wide">
            {parsed.actions.length === 1 ? "Action" : `${parsed.actions.length} Actions`}
          </div>
          {parsed.actions.map((action, i) => (
            <ActionCard key={i} action={action} />
          ))}
        </div>
      )}
    </div>
  );
}
