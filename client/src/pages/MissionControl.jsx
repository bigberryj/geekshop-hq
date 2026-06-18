import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';
import {
  Activity, Bot, Check, ChevronDown, ChevronUp, Clock, ExternalLink,
  ListChecks, Plus, RefreshCw, RotateCcw, Send, X, AlertTriangle,
} from 'lucide-react';

/**
 * Mission Control — real-time back-end view of the agent task queue.
 *
 * Live polls every 5s. The drawer lets Byron see the original ask, the
 * worker's self-review checklist, the evidence path, and decide:
 *   - Approve  (review -> done)
 *   - Send back (review|blocked -> queued, with a note)
 *   - Cancel   (review|blocked -> cancelled)
 *
 * Self-review status colors (the gate the worker writes before the task
 * reaches `review`):
 *   green  = pass
 *   red    = fail
 *   slate  = not yet reviewed (status is queued|running)
 */

const STATUS_FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'review', label: 'Review' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'failed', label: 'Failed' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

const STATUS_BADGE = {
  queued:    'badge-slate',
  running:   'badge-yellow',
  review:    'badge bg-blue-100 text-blue-800',
  blocked:   'badge-red',
  failed:    'badge-red',
  done:      'badge-green',
  cancelled: 'badge-slate',
};

function relTime(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(toIsoDate(iso)).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function liveDuration(startedIso, finishedIso) {
  if (!startedIso) return null;
  const start = new Date(toIsoDate(startedIso)).getTime();
  const end = finishedIso ? new Date(toIsoDate(finishedIso)).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * SQLite's `CURRENT_TIMESTAMP` returns "YYYY-MM-DD HH:MM:SS" in UTC with
 * no zone marker. JS's Date parser treats that as local time, which is
 * wrong on machines whose clock isn't UTC. Append a "Z" so the parser
 * knows what's going on, and pass through any input that already has a
 * zone marker (e.g. ISO strings from the worker).
 */
function toIsoDate(value) {
  if (!value) return value;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return value.replace(' ', 'T') + 'Z';
}

/**
 * ProgressBar for a running task.
 *   pct is 0-100 or null/undefined → falls back to indeterminate (sliding stripe).
 *   msg is the latest progress_message from the worker, shown under the bar when set.
 */
function ProgressBar({ pct, msg }) {
  const known = Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const width = known ? `${Math.max(2, Math.round(pct))}%` : '35%';
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div className="mc-progress-track flex-1" title={known ? `${pct}%` : 'progress unknown'}>
        <div
          className={`mc-progress-fill${known ? '' : ' indeterminate'}`}
          style={{ width: known ? width : '35%' }}
        />
      </div>
      <span className="text-xs font-mono text-slate-500 tabular-nums w-9 text-right">
        {known ? `${Math.round(pct)}%` : '…'}
      </span>
      {msg && <span className="text-xs text-slate-600 truncate max-w-[260px]" title={msg}>{msg}</span>}
    </div>
  );
}

function ReviewChecklist({ items = [] }) {
  if (!items.length) return <p className="text-sm text-slate-500">No checklist items.</p>;
  return (
    <ul className="space-y-1">
      {items.map((it, i) => {
        const pass = it.pass === true;
        const fail = it.pass === false;
        return (
          <li key={i} className="flex items-start gap-2 text-sm">
            {pass && <Check size={14} className="text-green-600 mt-0.5 flex-shrink-0" />}
            {fail && <X size={14} className="text-red-600 mt-0.5 flex-shrink-0" />}
            {!pass && !fail && <Clock size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />}
            <div className="flex-1">
              <div className={pass ? 'text-slate-800' : fail ? 'text-slate-800' : 'text-slate-500'}>
                {it.req || '(no requirement text)'}
              </div>
              {it.note && <div className="text-xs text-slate-500 mt-0.5">{it.note}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function NewTaskForm({ onCreated, onCancel }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !prompt.trim()) {
      setError('Title and prompt are both required.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await postJson('/agent-tasks', {
        title: title.trim(),
        prompt: prompt.trim(),
        source: 'hq_ui',
        priority,
      });
      onCreated(created);
      setTitle(''); setPrompt(''); setPriority(0);
    } catch (e2) {
      setError(e2.response?.data?.error || e2.message || 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h3 className="font-semibold flex items-center gap-2"><Plus size={16} /> New task</h3>
      <div>
        <label className="text-xs text-slate-500">Title (one line)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
               placeholder="e.g. Fix PDF export on the Money page" maxLength={240} />
      </div>
      <div>
        <label className="text-xs text-slate-500">Prompt (the full ask, self-contained)</label>
        <textarea className="input min-h-[120px] font-mono text-xs" value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What's the task? What does done look like? Any constraints?" />
        <p className="text-xs text-slate-400 mt-1">Worker sessions start fresh — include all context here.</p>
      </div>
      <div>
        <label className="text-xs text-slate-500">Priority</label>
        <input type="number" className="input w-24" value={priority}
               onChange={(e) => setPriority(Number(e.target.value) || 0)} />
        <p className="text-xs text-slate-400 mt-1">Higher = picked first.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={submitting} type="submit">
          {submitting ? 'Queueing…' : 'Queue task'}
        </button>
        <button className="btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function TaskDrawer({ taskId, onClose, onChanged }) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [reopenNote, setReopenNote] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const t = await fetchJson(`/agent-tasks/${taskId}`);
      setTask(t);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  const decide = async (action) => {
    setActing(true);
    try {
      const updated = await postJson(`/agent-tasks/${taskId}/decision`, { action, note });
      setTask(updated);
      setNote('');
      onChanged?.(updated);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setActing(false);
    }
  };

  const reopen = async () => {
    setActing(true);
    try {
      const updated = await postJson(`/agent-tasks/${taskId}/reopen`, { note: reopenNote });
      setTask(updated);
      setReopenNote('');
      onChanged?.(updated);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setActing(false);
    }
  };

  if (!taskId) return null;
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-6 shadow-xl"
           onClick={(e) => e.stopPropagation()}>
        {loading && <p>Loading…</p>}
        {error && <p className="text-red-600 text-sm">{error}</p>}
        {task && (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold">{task.title}</h3>
                <p className="text-xs text-slate-500 font-mono mt-1">
                  {task.uid} · {task.source} · priority {task.priority}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  <span className={`${STATUS_BADGE[task.status] || 'badge-slate'} mr-2`}>{task.status}</span>
                  attempts {task.attempts}/{task.max_attempts}
                </p>
              </div>
              <button className="btn-ghost" onClick={onClose} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <section>
              <h4 className="font-medium text-sm text-slate-500 mb-1">Original ask</h4>
              <pre className="bg-slate-50 border border-slate-200 rounded-md p-3 text-xs whitespace-pre-wrap font-mono">{task.prompt}</pre>
            </section>

            {task.acceptance_criteria?.length > 0 && (
              <section>
                <h4 className="font-medium text-sm text-slate-500 mb-1 flex items-center gap-1">
                  <ListChecks size={14} /> Acceptance criteria
                </h4>
                <ul className="text-sm space-y-0.5">
                  {task.acceptance_criteria.map((c, i) => (
                    <li key={i} className="text-slate-700">· {c.req}</li>
                  ))}
                </ul>
              </section>
            )}

            {task.result_summary && (
              <section>
                <h4 className="font-medium text-sm text-slate-500 mb-1">Worker summary</h4>
                <p className="text-sm whitespace-pre-wrap">{task.result_summary}</p>
              </section>
            )}

            {task.last_error && (
              <section>
                <h4 className="font-medium text-sm text-red-700 mb-1 flex items-center gap-1">
                  <AlertTriangle size={14} /> Last error
                </h4>
                <pre className="bg-red-50 border border-red-200 rounded-md p-3 text-xs whitespace-pre-wrap font-mono text-red-900">{task.last_error}</pre>
              </section>
            )}

            {task.review_checklist?.length > 0 && (
              <section>
                <h4 className="font-medium text-sm text-slate-500 mb-1 flex items-center gap-1">
                  <ListChecks size={14} /> Self-review
                </h4>
                <ReviewChecklist items={task.review_checklist} />
              </section>
            )}

            {task.evidence_path && (
              <section>
                <h4 className="font-medium text-sm text-slate-500 mb-1">Evidence</h4>
                <p className="font-mono text-xs break-all">{task.evidence_path}</p>
              </section>
            )}

            <section className="text-xs text-slate-500 grid grid-cols-2 gap-x-4 gap-y-1">
              <div>Created: <span className="font-mono">{task.created_at}</span> ({relTime(task.created_at)})</div>
              <div>Started: <span className="font-mono">{task.started_at || '—'}</span></div>
              <div>Last heartbeat: <span className="font-mono">{task.last_heartbeat_at || '—'}</span></div>
              <div>Finished: <span className="font-mono">{task.finished_at || '—'}</span></div>
              {task.worker_run_id && (
                <div className="col-span-2">Worker run id: <span className="font-mono">{task.worker_run_id}</span></div>
              )}
              {(task.started_at || task.finished_at) && (
                <div className="col-span-2">Duration: <span className="font-mono">{liveDuration(task.started_at, task.finished_at) || '—'}</span></div>
              )}
            </section>

            {(task.status === 'review' || task.status === 'blocked') && (
              <section className="border-t pt-4 space-y-2">
                <h4 className="font-medium text-sm">Your decision</h4>
                <textarea className="input min-h-[60px]" placeholder="Note (optional, goes on the task record)"
                          value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex gap-2 flex-wrap">
                  <button className="btn-primary" disabled={acting}
                          onClick={() => decide('approve')}>
                    <Check size={14} /> Approve
                  </button>
                  <button className="btn-secondary" disabled={acting}
                          onClick={() => decide('requeue')}>
                    <RotateCcw size={14} /> Send back / requeue
                  </button>
                  <button className="btn-ghost" disabled={acting}
                          onClick={() => decide('cancel')}>
                    <X size={14} /> Cancel
                  </button>
                </div>
              </section>
            )}

            {(task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') && (
              <section className="border-t pt-4 space-y-2">
                <h4 className="font-medium text-sm">Reopen</h4>
                <p className="text-xs text-slate-500">
                  This task is terminal. Reopen to reset it to <span className="font-mono">queued</span> so the worker cron can claim it again on the next tick.
                </p>
                <textarea className="input min-h-[60px]" placeholder="Why are you reopening? (goes on the task record)"
                          value={reopenNote} onChange={(e) => setReopenNote(e.target.value)} />
                <div className="flex gap-2">
                  <button className="btn-secondary" disabled={acting}
                          onClick={reopen}>
                    <RotateCcw size={14} /> Reopen
                  </button>
                </div>
              </section>
            )}

            {task.decision && (
              <section className="text-xs text-slate-600 border-t pt-3">
                <p>Decision: <span className="font-mono">{task.decision}</span> by {task.decided_by || '?'} at {task.decided_at}</p>
                {task.decision_note && <p className="mt-1">Note: {task.decision_note}</p>}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MissionControl() {
  const [status, setStatus] = useState('open');
    const [list, setList] = useState({ items: [], total: 0 });
    const [summary, setSummary] = useState(null);
    const [showNew, setShowNew] = useState(false);
    const [openId, setOpenId] = useState(null);
    const [error, setError] = useState(null);
    const [now, setNow] = useState(Date.now());
    const [tick, setTick] = useState(0);
    // Row animation state:
    //   seenIds: tasks we've seen on a previous poll (used to detect "new this tick" → slide in)
    //   exitingIds: tasks that transitioned from non-terminal → terminal last tick (fade out)
    const [seenIds, setSeenIds] = useState(() => new Set());
    const [exitingIds, setExitingIds] = useState(() => new Set());
    const intervalRef = useRef(null);

    const reload = useCallback(async () => {
      try {
        const [a, b] = await Promise.all([
          fetchJson(`/agent-tasks?status=${status}&limit=200`),
          fetchJson('/agent-tasks/summary'),
        ]);
        // Compute exit transitions BEFORE we replace list. A task that
        // was running/queued/review/blocked on the previous poll but is now
        // done/failed/cancelled (or no longer in the filtered view) gets
        // a one-tick fade-out before disappearing.
        const prevIds = seenIds;
        const newIds = new Set(a.items.map((t) => t.id));
        const terminal = (s) => s === 'done' || s === 'failed' || s === 'cancelled';
        const justExited = [];
        for (const id of prevIds) {
          const inCurrent = a.items.find((t) => t.id === id);
          const wasOpen = prevIds.has(id); // any seen id counts
          if (!inCurrent || terminal(inCurrent.status)) {
            // Find the previous status (we don't have it here, so assume
            // anything that newly shows terminal was non-terminal last poll)
            justExited.push(id);
          }
        }
        if (justExited.length) {
          setExitingIds((cur) => new Set([...cur, ...justExited]));
          // Clear exit flag after the fade animation completes.
          setTimeout(() => {
            setExitingIds((cur) => {
              const next = new Set(cur);
              justExited.forEach((id) => next.delete(id));
              return next;
            });
          }, 650);
        }
        setList(a); setSummary(b); setError(null);
        setSeenIds(newIds);
      } catch (e) {
        setError(e.response?.data?.error || e.message);
      }
    }, [status, seenIds]);

    useEffect(() => { reload(); }, [reload]);
    useEffect(() => { setTick((t) => t + 1); }, [reload]);

    // Poll every 5s for the live view
    useEffect(() => {
      intervalRef.current = setInterval(() => { reload(); setNow(Date.now()); }, 5000);
      return () => clearInterval(intervalRef.current);
    }, [reload]);

    // Heartbeat for the duration column (every 1s)
    useEffect(() => {
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }, []);

  const onCreated = () => { setShowNew(false); reload(); };
  const onChanged = () => { reload(); };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Bot size={24} className="text-brand-600" />
          <h2 className="text-2xl font-bold">Mission Control</h2>
          <span className="text-xs text-slate-500 ml-2">auto-refresh 5s</span>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={reload}><RefreshCw size={14} /> Refresh</button>
          <button className="btn-primary" onClick={() => setShowNew((s) => !s)}>
            <Plus size={14} /> New task
          </button>
        </div>
      </div>

      <nav className="flex gap-4 border-b border-slate-200 mb-4 text-sm">
        <Link to="/mission-control" className="pb-2 border-b-2 border-brand-600 text-brand-700 font-medium">Tasks</Link>
        <Link to="/mission-control/agents" className="pb-2 border-b-2 border-transparent text-slate-500 hover:text-slate-800">Agents</Link>
        <Link to="/mission-control/feed" className="pb-2 border-b-2 border-transparent text-slate-500 hover:text-slate-800">Live</Link>
      </nav>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-7 gap-2 mb-4">
          {['queued', 'running', 'review', 'blocked', 'failed', 'done', 'cancelled'].map((s) => (
            <div key={s} className="card text-center py-2">
              <div className="text-xs text-slate-500 uppercase">{s}</div>
              <div className="text-xl font-bold">{summary[s] ?? 0}</div>
            </div>
          ))}
        </div>
      )}

      {showNew && <div className="mb-4"><NewTaskForm onCreated={onCreated} onCancel={() => setShowNew(false)} /></div>}

      <div className="card mb-4">
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key}
                    className={`px-3 py-1 rounded-md text-xs ${status === f.key ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                    onClick={() => setStatus(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 text-xs uppercase">
              <th className="py-2 pr-2">Task</th>
              <th className="py-2 pr-2">Status</th>
              <th className="py-2 pr-2">Source</th>
              <th className="py-2 pr-2">Priority</th>
              <th className="py-2 pr-2">Age</th>
              <th className="py-2 pr-2">Duration</th>
              <th className="py-2 pr-2 min-w-[180px]">Progress</th>
              <th className="py-2 pr-2">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {list.items.length === 0 && (
              <tr><td colSpan={8} className="py-6 text-center text-slate-500">No tasks in this view.</td></tr>
            )}
            {list.items.map((t) => {
              const isNew = !seenIds.has(t.id) && seenIds.size > 0; // skip first poll (no "previous" baseline)
              const isExiting = exitingIds.has(t.id);
              const rowClass = [
                'border-t border-slate-100 hover:bg-slate-50 cursor-pointer',
                isNew ? 'mc-row-enter' : '',
                isExiting ? 'mc-row-exit' : '',
              ].filter(Boolean).join(' ');
              return (
              <tr key={t.id} className={rowClass}
                  onClick={() => setOpenId(t.id)}>
                <td className="py-2 pr-2">
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-slate-500 font-mono">{t.uid}</div>
                </td>
                <td className="py-2 pr-2">
                  <span className={STATUS_BADGE[t.status] || 'badge-slate'}>{t.status}</span>
                </td>
                <td className="py-2 pr-2 text-xs text-slate-500">{t.source}</td>
                <td className="py-2 pr-2 text-xs">{t.priority}</td>
                <td className="py-2 pr-2 text-xs text-slate-500" title={t.created_at}>{relTime(t.created_at)}</td>
                <td className="py-2 pr-2 text-xs font-mono">
                  {t.status === 'running' && <span className="text-yellow-700">{liveDuration(t.started_at, null, now)}</span>}
                  {t.status !== 'running' && liveDuration(t.started_at, t.finished_at)}
                </td>
                <td className="py-2 pr-2 text-xs">
                  {t.status === 'running'
                    ? <ProgressBar pct={t.progress_pct} msg={t.progress_message} />
                    : <span className="text-slate-400">—</span>}
                </td>
                <td className="py-2 pr-2 text-xs">{t.attempts}/{t.max_attempts}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {list.items.length > 0 && (
        <p className="text-xs text-slate-500 mt-2">
          Showing {list.items.length} of {list.total}.
        </p>
      )}

      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChanged={onChanged} />}
    </div>
  );
}
