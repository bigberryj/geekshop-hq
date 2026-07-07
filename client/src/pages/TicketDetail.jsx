import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { fetchJson, postJson, delJson, patchJson } from '../lib/api.js';
import {
  Sparkles, Send, CheckCircle, Play, Square, Pause, RotateCw, Trash2, RotateCcw,
  Plus, X, Pencil, Clock,
} from 'lucide-react';
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

// Convert a `datetime-local` input value (which has no timezone) into a
// YYYY-MM-DD HH:MM:SS UTC string that SQLite CURRENT_TIMESTAMP compares
// against. The form always shows the operator's local time; we normalize
// to UTC on the way out.
function localInputToDbUtc(value) {
  if (!value) return null;
  // `<input type="datetime-local">` returns "YYYY-MM-DDTHH:MM" with no tz.
  // new Date() parses that as LOCAL time; toISOString() gives the UTC form.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// Convert a DB timestamp back into a `datetime-local` value for the form.
function dbUtcToLocalInput(value) {
  if (!value) return '';
  const d = parseDbTimestamp(value);
  if (Number.isNaN(d)) return '';
  // toISOString → "YYYY-MM-DDTHH:MM:SS.sssZ"; strip to "YYYY-MM-DDTHH:MM"
  // so the input shows the operator's local clock.
  const local = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

function formatEntryDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return '0m';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [draft, setDraft] = useState('');
  const [originalDraft, setOriginalDraft] = useState(''); // for feedback diff
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [timerBusy, setTimerBusy] = useState(false);
  const [error, setError] = useState('');
  const [timeEntries, setTimeEntries] = useState([]);
  const [clockTick, setClockTick] = useState(Date.now());
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualStartedAt, setManualStartedAt] = useState('');
  const [manualStoppedAt, setManualStoppedAt] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [editStartedAt, setEditStartedAt] = useState('');
  const [editStoppedAt, setEditStoppedAt] = useState('');
  const [editNote, setEditNote] = useState('');

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

  const deleteTicket = async () => {
    if (!window.confirm(
      `Delete this ticket ("${ticket.subject}")?\n\n` +
      `It will be hidden from the default list and the dashboard. The audit log, customer history, ` +
      `and any time entries are kept — you can restore it from the Tickets page (Show trash).`,
    )) return;
    setBusy(true);
    try {
      await delJson(`/tickets/${id}`);
      // Navigate back to the list so the operator sees the cleaned-up view
      navigate('/tickets');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  const restoreTicket = async () => {
    setBusy(true);
    try {
      await postJson(`/tickets/${id}/restore`, {});
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
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

  const submitManualEntry = async (e) => {
    e.preventDefault();
    if (!manualStartedAt || !manualStoppedAt) {
      setError('Start and stop times are required for a manual entry.');
      return;
    }
    if (new Date(manualStartedAt) >= new Date(manualStoppedAt)) {
      setError('Stop time must be after start time.');
      return;
    }
    setTimerBusy(true);
    setError(null);
    try {
      await postJson(`/tickets/${id}/time`, {
        started_at: localInputToDbUtc(manualStartedAt),
        stopped_at: localInputToDbUtc(manualStoppedAt),
        note: manualNote.trim() || null,
      });
      setShowManualEntry(false);
      setManualStartedAt('');
      setManualStoppedAt('');
      setManualNote('');
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setTimerBusy(false); }
  };

  const startEditEntry = (entry) => {
    setEditingEntryId(entry.id);
    setEditStartedAt(dbUtcToLocalInput(entry.started_at));
    setEditStoppedAt(dbUtcToLocalInput(entry.stopped_at));
    setEditNote(entry.note || '');
  };

  const submitEditEntry = async (e) => {
    e.preventDefault();
    if (!editingEntryId) return;
    if (new Date(editStartedAt) >= new Date(editStoppedAt)) {
      setError('Stop time must be after start time.');
      return;
    }
    setTimerBusy(true);
    setError(null);
    try {
      await patchJson(`/tickets/${id}/time/${editingEntryId}`, {
        started_at: localInputToDbUtc(editStartedAt),
        stopped_at: localInputToDbUtc(editStoppedAt),
        note: editNote.trim() || null,
      });
      setEditingEntryId(null);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setTimerBusy(false); }
  };

  const deleteEntry = async (entry) => {
    if (!window.confirm(
      `Delete this time entry (${formatEntryDuration(entry.duration_seconds)}, started ${new Date(entry.started_at).toLocaleString()})?`,
    )) return;
    setTimerBusy(true);
    setError(null);
    try {
      await delJson(`/tickets/${id}/time/${entry.id}`);
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
      {ticket.deleted_at && (
        <div className="card mb-4 bg-amber-50 border-amber-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-amber-900">
              <strong>Deleted ticket.</strong> Hidden from the default list and the dashboard.
              Audit log, customer history, and time entries are preserved.
            </div>
            <button
              className="btn-primary tap-target"
              onClick={restoreTicket}
              disabled={busy}
              data-testid="ticket-detail-restore"
            >
              <RotateCcw size={14} /> Restore ticket
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 mb-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold break-words">{ticket.subject}</h2>
          <div className="text-sm text-slate-500 mt-1 break-words">
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
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {!activeTimer && (
          <button className="btn-secondary tap-target" onClick={() => timerAction('start')} disabled={timerBusy} data-testid="start-timer-button">
            <Play size={14} /> Start timer
          </button>
        )}
        {activeTimer?.status === 'running' && (
          <button className="btn-secondary tap-target" onClick={() => timerAction('pause')} disabled={timerBusy} data-testid="pause-timer-button">
            <Pause size={14} /> Pause
          </button>
        )}
        {activeTimer?.status === 'paused' && (
          <button className="btn-secondary tap-target" onClick={() => timerAction('resume')} disabled={timerBusy} data-testid="resume-timer-button">
            <RotateCw size={14} /> Resume
          </button>
        )}
        {activeTimer && (
          <button className="btn-secondary tap-target" onClick={() => timerAction('stop')} disabled={timerBusy} data-testid="stop-timer-button">
            <Square size={14} /> Stop
          </button>
        )}
        <button
          className="btn-secondary tap-target"
          onClick={() => setShowManualEntry((v) => !v)}
          disabled={timerBusy}
          data-testid="manual-entry-toggle"
        >
          {showManualEntry ? <X size={14} /> : <Plus size={14} />}
          {showManualEntry ? 'Cancel' : 'Log time manually'}
        </button>
        {ticket.status !== 'resolved' && (
          <button className="btn-primary tap-target" onClick={resolve} disabled={busy}>
            <CheckCircle size={14} /> Mark resolved
          </button>
        )}
        {!ticket.deleted_at && (
          <button
            className="btn-ghost tap-target text-red-600 text-xs ml-auto"
            onClick={deleteTicket}
            disabled={busy}
            data-testid="ticket-detail-delete"
            title="Soft-delete this ticket. The audit log and customer history are kept; you can restore it from the trash view."
          >
            <Trash2 size={12} /> Delete ticket
          </button>
        )}
      </div>

      {showManualEntry && (
        <form onSubmit={submitManualEntry} className="card mb-4 border-l-4 border-l-brand-400" data-testid="manual-entry-form">
          <h4 className="font-semibold text-sm mb-2">Log time manually</h4>
          <p className="text-xs text-slate-500 mb-3">
            For when you forgot to start the timer, or you need to backfill time from a paper invoice.
            Times are interpreted in your local timezone.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <label className="text-xs">
              <span className="block text-slate-600 mb-1">Started</span>
              <input
                type="datetime-local"
                className="input"
                value={manualStartedAt}
                onChange={(e) => setManualStartedAt(e.target.value)}
                required
                data-testid="manual-entry-started"
              />
            </label>
            <label className="text-xs">
              <span className="block text-slate-600 mb-1">Stopped</span>
              <input
                type="datetime-local"
                className="input"
                value={manualStoppedAt}
                onChange={(e) => setManualStoppedAt(e.target.value)}
                required
                data-testid="manual-entry-stopped"
              />
            </label>
          </div>
          <label className="text-xs block mb-3">
            <span className="block text-slate-600 mb-1">Note (optional)</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. on-site repair, parts run, etc."
              value={manualNote}
              onChange={(e) => setManualNote(e.target.value)}
              data-testid="manual-entry-note"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowManualEntry(false)}
              disabled={timerBusy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={timerBusy}
              data-testid="manual-entry-submit"
            >
              <Clock size={14} /> Save entry
            </button>
          </div>
        </form>
      )}

      {timeEntries.length > 0 && (
        <div className="card mb-4">
          <h4 className="font-semibold text-sm mb-2">Time on this ticket</h4>
          <div className="divide-y">
            {timeEntries.map((entry) => (
              <div key={entry.id} className="py-2 first:pt-0 last:pb-0" data-testid={`time-entry-${entry.id}`}>
                {editingEntryId === entry.id ? (
                  <form onSubmit={submitEditEntry} className="flex flex-col gap-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <label className="text-xs">
                        <span className="block text-slate-600 mb-1">Started</span>
                        <input
                          type="datetime-local"
                          className="input"
                          value={editStartedAt}
                          onChange={(e) => setEditStartedAt(e.target.value)}
                          required
                          data-testid={`edit-started-${entry.id}`}
                        />
                      </label>
                      <label className="text-xs">
                        <span className="block text-slate-600 mb-1">Stopped</span>
                        <input
                          type="datetime-local"
                          className="input"
                          value={editStoppedAt}
                          onChange={(e) => setEditStoppedAt(e.target.value)}
                          required
                          data-testid={`edit-stopped-${entry.id}`}
                        />
                      </label>
                    </div>
                    <label className="text-xs">
                      <span className="block text-slate-600 mb-1">Note</span>
                      <input
                        type="text"
                        className="input"
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        data-testid={`edit-note-${entry.id}`}
                      />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setEditingEntryId(null)}
                        disabled={timerBusy}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="btn-primary text-xs"
                        disabled={timerBusy}
                        data-testid={`edit-save-${entry.id}`}
                      >
                        Save changes
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={`badge-${entry.status === 'running' ? 'green' : entry.status === 'paused' ? 'yellow' : 'slate'}`} data-testid={`time-entry-status-${entry.id}`}>
                      {entry.status}
                    </span>
                    <span className="font-mono tabular-nums" data-testid={`time-entry-duration-${entry.id}`}>
                      {entry.status === 'stopped' ? formatEntryDuration(entry.duration_seconds) : formatTimerDuration(entry.elapsed_seconds)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {new Date(entry.started_at).toLocaleString()}{entry.stopped_at ? ` → ${new Date(entry.stopped_at).toLocaleString()}` : ' (active)'}
                    </span>
                    {entry.note && <span className="text-xs text-slate-600 italic truncate flex-1 min-w-0">— {entry.note}</span>}
                    {!entry.invoiced_at && entry.status === 'stopped' && (
                      <div className="ml-auto flex gap-1">
                        <button
                          className="btn-ghost text-xs"
                          onClick={() => startEditEntry(entry)}
                          disabled={timerBusy}
                          data-testid={`edit-entry-${entry.id}`}
                          title="Edit this time entry"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="btn-ghost text-xs text-red-600"
                          onClick={() => deleteEntry(entry)}
                          disabled={timerBusy}
                          data-testid={`delete-entry-${entry.id}`}
                          title="Delete this time entry"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="card mb-4 bg-red-50 border-red-200 text-sm text-red-800" role="alert" data-testid="ticket-error">
          {error}
          <button className="ml-2 text-red-700 hover:underline" onClick={() => setError('')}>×</button>
        </div>
      )}

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
            <div key={m.id} className={`p-3 rounded break-words ${m.sender === 'admin' ? 'bg-brand-50 ml-2 md:ml-8' : 'bg-slate-50 mr-2 md:mr-8'}`}>
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
          <button className="btn-secondary" onClick={generateDraft} disabled={busy || ticket.deleted_at}>
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
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn-secondary tap-target" onClick={() => sendReply(true)} disabled={busy}>
                Save to convo
              </button>
              <button className="btn-primary tap-target" onClick={() => emailReply(true)} disabled={busy}>
                <Send size={14} /> Email customer
              </button>
              {ticket.status !== 'resolved' && (
                <button className="btn-primary bg-emerald-600 hover:bg-emerald-700 tap-target" onClick={() => resolveWithReply(true)} disabled={busy}>
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
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button className="btn-secondary tap-target" onClick={() => sendReply(false)} disabled={busy || !reply}>
            Save to convo
          </button>
          <button className="btn-primary tap-target" onClick={() => emailReply(false)} disabled={busy || !reply}>
            <Send size={14} /> Email customer
          </button>
          {ticket.status !== 'resolved' && (
            <button className="btn-primary bg-emerald-600 hover:bg-emerald-700 tap-target" onClick={() => resolveWithReply(false)} disabled={busy || !reply}>
              <CheckCircle size={14} /> Reply & resolve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
