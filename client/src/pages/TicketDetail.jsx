import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';
import { Sparkles, Send, CheckCircle, Play, Square, Pause, RotateCw } from 'lucide-react';
import EmailBody from '../components/EmailBody.jsx';

function formatTimerDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

function parseDbTimestamp(value) {
  if (!value) return NaN;
  if (typeof value !== 'string') return new Date(value).getTime();
  // SQLite CURRENT_TIMESTAMP returns UTC as "YYYY-MM-DD HH:mm:ss" without a
  // timezone. Browsers treat that as local time, so force UTC before math.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return new Date(normalized).getTime();
}

export default function TicketDetail() {
  const { id } = useParams();
  const [ticket, setTicket] = useState(null);
  const [draft, setDraft] = useState('');
  const [originalDraft, setOriginalDraft] = useState(''); // for feedback diff
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [timerBusy, setTimerBusy] = useState(false);
  const [error, setError] = useState('');
  const [timeEntries, setTimeEntries] = useState([]);
  const [clockTick, setClockTick] = useState(Date.now());

  const load = async () => {
    const [ticketData, timeData] = await Promise.all([
      fetchJson(`/tickets/${id}`),
      fetchJson(`/tickets/${id}/time`),
    ]);
    setTicket(ticketData);
    setTimeEntries(timeData);
  };
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    const timer = setInterval(() => setClockTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!ticket) return <div>Loading…</div>;

  const generateDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson(`/tickets/${id}/ai-draft`, {});
      setDraft(r.draft);
      setOriginalDraft(r.draft); // snapshot for feedback comparison
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  // Fire-and-forget style feedback. If Byron edited the draft before sending,
  // POST the (original, final) pair so the AI learns from the change.
  const maybeCaptureFeedback = (finalText) => {
    if (!originalDraft || !finalText) return;
    if (originalDraft === finalText) return;
    if (originalDraft.length < 10 || finalText.length < 5) return; // skip trivial
    postJson(`/tickets/${id}/ai-draft/feedback`, {
      draft_text: originalDraft,
      final_text: finalText,
    }).catch(() => { /* non-blocking */ });
  };

  const sendReply = async (useDraft) => {
    const body = useDraft ? draft : reply;
    if (!body) return;
    setBusy(true);
    try {
      await postJson(`/tickets/${id}/messages`, { body, ai_draft: useDraft ? 1 : 0 });
      if (useDraft) maybeCaptureFeedback(body);
      setReply(''); setDraft(''); setOriginalDraft('');
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  // Send the current draft/reply to the customer as an email (does NOT resolve)
  const emailReply = async (useDraft) => {
    const body = useDraft ? draft : reply;
    if (!body) return;
    setBusy(true);
    try {
      const result = await postJson(`/tickets/${id}/email-reply`, { body });
      if (result.sent) {
        if (useDraft) maybeCaptureFeedback(body);
        setReply(''); setDraft(''); setOriginalDraft('');
        load();
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  // The "mark done + send reply" button — email customer + resolve + archive Gmail
  const resolveWithReply = async (useDraft) => {
    const body = useDraft ? draft : reply;
    if (!body) return;
    setBusy(true);
    try {
      const result = await postJson(`/tickets/${id}/resolve-with-reply`, { reply_body: body });
      if (result.ok) {
        if (useDraft) maybeCaptureFeedback(body);
        setReply(''); setDraft(''); setOriginalDraft('');
        load();
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  const resolve = async () => {
    setBusy(true);
    try { await postJson(`/tickets/${id}/resolve`, {}); load(); } finally { setBusy(false); }
  };

  const activeTimer = timeEntries.find((entry) => !entry.stopped_at) || null;
  const elapsedSeconds = (() => {
    if (!activeTimer) return 0;
    const base = Number(activeTimer.duration_seconds ?? activeTimer.elapsed_seconds ?? 0);
    if (activeTimer.status !== 'running') return base;
    const startedAt = parseDbTimestamp(activeTimer.started_at);
    if (Number.isNaN(startedAt)) return Number(activeTimer.elapsed_seconds ?? base);
    return Math.max(0, Math.floor(base + ((clockTick - startedAt) / 1000)));
  })();

  const timerAction = async (action) => {
    setTimerBusy(true);
    setError(null);
    try {
      await postJson(`/tickets/${id}/time/${action}`, {});
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setTimerBusy(false); }
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
            <Link to={`/customers/${ticket.customer_id}`} className="text-brand-600 hover:underline font-medium">{ticket.customer_name}</Link>
            {ticket.ticket_uid && (
              <span
                className="ml-2 font-mono text-xs text-slate-400"
                title={`Internal ID: ${ticket.ticket_uid} — admin reference only, never shown to customer`}
              >
                {ticket.ticket_uid}
              </span>
            )}
            {ticket.source === 'email' && ticket.source_message_id && (
              <span className="ml-2 text-xs text-slate-400" title={`Gmail Message-ID: ${ticket.source_message_id}`}>
                · ✉️
              </span>
            )}
            {ticket.source === 'booking' && (
              <span className="ml-2 text-xs text-slate-400" title="Created from a public booking"> · 📅</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge-${ticket.priority === 'urgent' ? 'red' : 'slate'}`}>{ticket.priority}</span>
          <span className={`badge-${ticket.status === 'open' ? 'green' : 'slate'}`}>{ticket.status}</span>
          {activeTimer && (
            <div className="flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm" data-testid="ticket-timer-panel">
              <span className="font-mono font-semibold tabular-nums" data-testid="ticket-timer-elapsed">
                {formatTimerDuration(elapsedSeconds)}
              </span>
              <span className={`badge-${activeTimer.status === 'running' ? 'green' : 'yellow'}`} data-testid="ticket-timer-status">
                {activeTimer.status}
              </span>
            </div>
          )}
          {!activeTimer && (
            <button className="btn-secondary" onClick={() => timerAction('start')} disabled={timerBusy} data-testid="start-timer-button">
              <Play size={14} /> Start timer
            </button>
          )}
          {activeTimer?.status === 'running' && (
            <button className="btn-secondary" onClick={() => timerAction('pause')} disabled={timerBusy} data-testid="pause-timer-button">
              <Pause size={14} /> Pause
            </button>
          )}
          {activeTimer?.status === 'paused' && (
            <button className="btn-secondary" onClick={() => timerAction('resume')} disabled={timerBusy} data-testid="resume-timer-button">
              <RotateCw size={14} /> Resume
            </button>
          )}
          {activeTimer && (
            <button className="btn-secondary" onClick={() => timerAction('stop')} disabled={timerBusy} data-testid="stop-timer-button">
              <Square size={14} /> Stop
            </button>
          )}
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
              <EmailBody body={m.body} body_html={m.body_html} attachments={m.attachments || []} />
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
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-slate-500">
                AI draft — edit below before sending. Your edits help the AI learn your voice.
              </div>
              {draft !== originalDraft && (
                <span className="text-xs text-amber-700 font-medium" data-testid="draft-edited">edited</span>
              )}
            </div>
            <textarea
              className="input min-h-[100px] bg-white"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="ai-draft-textarea"
            />
            <div className="mt-2 flex gap-2">
              <button className="btn-secondary" onClick={() => sendReply(true)} disabled={busy}>
                Save to convo
              </button>
              <button className="btn-primary" onClick={() => emailReply(true)} disabled={busy}>
                <Send size={14} /> Email customer
              </button>
              {ticket.status !== 'resolved' && (
                <button className="btn-primary bg-emerald-600 hover:bg-emerald-700" onClick={() => resolveWithReply(true)} disabled={busy}>
                  <CheckCircle size={14} /> Reply & resolve
                </button>
              )}
            </div>
          </div>
        )}
        <textarea
          className="input min-h-[120px]"
          placeholder="Type your reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => sendReply(false)} disabled={busy || !reply}>
            Save to convo
          </button>
          <button className="btn-primary" onClick={() => emailReply(false)} disabled={busy || !reply}>
            <Send size={14} /> Email customer
          </button>
          {ticket.status !== 'resolved' && (
            <button className="btn-primary bg-emerald-600 hover:bg-emerald-700" onClick={() => resolveWithReply(false)} disabled={busy || !reply}>
              <CheckCircle size={14} /> Reply & resolve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
