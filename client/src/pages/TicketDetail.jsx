import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchJson, postJson, formatDuration } from '../lib/api.js';
import { Sparkles, Send, CheckCircle, Play, Square, RotateCw } from 'lucide-react';

export default function TicketDetail() {
  const { id } = useParams();
  const [ticket, setTicket] = useState(null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => fetchJson(`/tickets/${id}`).then(setTicket);
  useEffect(() => { load(); }, [id]);

  if (!ticket) return <div>Loading…</div>;

  const generateDraft = async () => {
    setBusy(true);
    try {
      const { draft } = await postJson(`/tickets/${id}/ai-draft`, {});
      setDraft(draft);
    } finally { setBusy(false); }
  };

  const sendReply = async (useDraft) => {
    const body = useDraft ? draft : reply;
    if (!body) return;
    setBusy(true);
    try {
      await postJson(`/tickets/${id}/messages`, { body, ai_draft: useDraft ? 1 : 0 });
      setReply(''); setDraft('');
      load();
    } finally { setBusy(false); }
  };

  const resolve = async () => {
    setBusy(true);
    try { await postJson(`/tickets/${id}/resolve`, {}); load(); } finally { setBusy(false); }
  };

  const toggleTimer = async () => {
    const running = ticket.messages && false;  // simplification; real impl reads from /tickets/:id/time
    setBusy(true);
    try {
      if (running) await postJson(`/tickets/${id}/time/stop`, {});
      else await postJson(`/tickets/${id}/time/start`, {});
      load();
    } finally { setBusy(false); }
  };

  return (
    <div className="max-w-4xl">
      <div className="mb-4">
        <Link to="/tickets" className="text-sm text-slate-500 hover:underline">← All tickets</Link>
      </div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold">{ticket.subject}</h2>
          <div className="text-sm text-slate-500 mt-1">
            {ticket.ticket_uid} · <Link to={`/customers/${ticket.customer_id}`} className="text-brand-600 hover:underline">{ticket.customer_name}</Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge-${ticket.priority === 'urgent' ? 'red' : 'slate'}`}>{ticket.priority}</span>
          <span className={`badge-${ticket.status === 'open' ? 'green' : 'slate'}`}>{ticket.status}</span>
          <button className="btn-secondary" onClick={toggleTimer} disabled={busy}>
            <Play size={14} /> Start timer
          </button>
          {ticket.status !== 'resolved' && (
            <button className="btn-primary" onClick={resolve} disabled={busy}>
              <CheckCircle size={14} /> Mark resolved
            </button>
          )}
        </div>
      </div>

      {ticket.customer_memory && ticket.customer_memory.length > 0 && (
        <div className="card mb-4 bg-amber-50 border-amber-200">
          <h4 className="font-semibold text-sm mb-2">Customer memory (used in AI drafts)</h4>
          <ul className="text-xs space-y-1">
            {ticket.customer_memory.map((m) => (
              <li key={m.id}>
                <span className="badge-yellow mr-1">{m.category}</span>
                <span className="text-slate-700">{m.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card mb-4">
        <h4 className="font-semibold text-sm mb-3">Conversation</h4>
        <div className="space-y-3">
          {ticket.messages.map((m) => (
            <div key={m.id} className={`p-3 rounded ${m.sender === 'admin' ? 'bg-brand-50 ml-8' : 'bg-slate-50 mr-8'}`}>
              <div className="text-xs text-slate-500 mb-1">
                {m.sender === 'admin' ? '👤 You' : '🧑 ' + ticket.customer_name}
                {m.ai_draft ? ' · (AI draft)' : ''}
                {' · '}{new Date(m.created_at).toLocaleString()}
              </div>
              <div className="text-sm whitespace-pre-wrap">{m.body}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-sm">Reply</h4>
          <button className="btn-secondary" onClick={generateDraft} disabled={busy}>
            <Sparkles size={14} /> {busy ? 'Thinking…' : 'AI draft reply'}
          </button>
        </div>
        {draft && (
          <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded">
            <div className="text-xs text-slate-500 mb-1">AI draft (click to use)</div>
            <div className="text-sm whitespace-pre-wrap">{draft}</div>
            <button className="btn-primary mt-2" onClick={() => sendReply(true)}>
              <Send size={14} /> Send this draft
            </button>
          </div>
        )}
        <textarea
          className="input min-h-[120px]"
          placeholder="Type your reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
        <div className="mt-2 flex justify-end">
          <button className="btn-primary" onClick={() => sendReply(false)} disabled={busy || !reply}>
            <Send size={14} /> Send
          </button>
        </div>
      </div>
    </div>
  );
}
