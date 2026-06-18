import { useEffect, useState, useRef } from 'react';
import { fetchJson } from '../lib/api.js';
import { Activity, RefreshCw, Wifi, WifiOff } from 'lucide-react';

/**
 * Mission Control — Live feed.
 *
 * Subscribes to /api/activity/stream (Server-Sent Events) and renders
 * the most recent events. Also bootstraps from /api/activity/recent
 * so the page shows history immediately on load.
 *
 * Event types:
 *   - task_claimed         — worker picked up a queued task
 *   - task_finished        — worker marked a task done/failed/review/blocked
 *   - task_decided         — Byron approved / requeued / cancelled
 *   - task_reopened        — Byron reopened a terminal task
 *   - agent_message_sent   — chat panel sent a message to an agent
 */
const EVENT_META = {
  task_claimed:       { icon: '▶', color: 'text-blue-600',   label: 'claimed' },
  task_finished:      { icon: '✓', color: 'text-emerald-600', label: 'finished' },
  task_decided:       { icon: '✋', color: 'text-purple-600',  label: 'decided' },
  task_reopened:      { icon: '↻', color: 'text-amber-600',   label: 'reopened' },
  agent_message_sent: { icon: '✉', color: 'text-sky-600',     label: 'message sent' },
  task_snapshot:      { icon: '◉', color: 'text-slate-400',   label: 'snapshot' },
};

export default function Feed() {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  // Bootstrap from /api/activity/recent then open SSE.
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const data = await fetchJson('/activity/recent?limit=50');
        if (cancelled) return;
        setEvents((data.events || []).reverse()); // oldest first
      } catch (e) {
        setError(e.message);
      }
    };
    bootstrap();

    const es = new EventSource('/api/activity/stream');
    esRef.current = es;
    es.onopen = () => { setConnected(true); setError(null); };
    es.onerror = () => { setConnected(false); };
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setEvents((prev) => {
          const next = [...prev, data];
          // Cap at 200 to avoid unbounded memory.
          return next.length > 200 ? next.slice(-200) : next;
        });
      } catch { /* ignore */ }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  // Newest first in the list, with a small sticky "live" indicator.
  const reversed = [...events].reverse();

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Activity className="w-6 h-6" /> Live
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time activity from worker cron, agent transitions, and chat sends.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {connected ? (
            <span className="flex items-center gap-1 text-emerald-700">
              <Wifi className="w-3.5 h-3.5" /> live
            </span>
          ) : (
            <span className="flex items-center gap-1 text-slate-500">
              <WifiOff className="w-3.5 h-3.5" /> reconnecting
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="card border-l-4 border-amber-400 p-3 text-sm text-amber-700">
          {error}
        </div>
      )}

      <div className="card divide-y">
        {reversed.length === 0 && (
          <div className="p-6 text-sm text-slate-500 text-center">
            Waiting for the first event…
          </div>
        )}
        {reversed.map((evt, i) => (
          <EventRow key={(evt.at || '') + i} event={evt} />
        ))}
      </div>
    </div>
  );
}

function EventRow({ event }) {
  const kind = event.kind || 'unknown';
  const meta = EVENT_META[kind] || { icon: '·', color: 'text-slate-500', label: kind };
  const at = event.at ? new Date(event.at) : new Date();

  return (
    <div className="px-4 py-3 flex items-start gap-3 text-sm">
      <div className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-slate-50 ${meta.color} font-bold`}>
        {meta.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`font-medium ${meta.color}`}>{meta.label}</span>
          {event.task?.id && (
            <a
              href={`/mission-control?task=${event.task.id}`}
              className="text-xs text-blue-600 hover:underline"
            >
              task #{event.task.id}
            </a>
          )}
          {event.agent_id && (
            <span className="text-xs text-slate-500">→ {event.agent_id}</span>
          )}
          {event.status && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">{event.status}</span>
          )}
        </div>
        {event.task?.title && (
          <div className="text-xs text-slate-500 truncate mt-0.5">{event.task.title}</div>
        )}
        {event.text_preview && (
          <div className="text-xs text-slate-500 mt-0.5 truncate">"{event.text_preview}"</div>
        )}
      </div>
      <div className="text-xs text-slate-400 flex-shrink-0">{time(at)}</div>
    </div>
  );
}

function time(d) {
  const today = new Date().toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  if (today) return `${hh}:${mm}:${ss}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
