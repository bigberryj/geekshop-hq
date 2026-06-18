import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchJson, postJson } from '../lib/api.js';
import {
  Activity, Bot, Check, ChevronDown, ChevronUp, Clock, ExternalLink,
  ListChecks, MessageSquare, Plus, RefreshCw, RotateCcw, Send, X, AlertTriangle,
  Cpu, Hash, Power, MessageCircle, Inbox,
} from 'lucide-react';

/**
 * Mission Control — Agents view.
 *
 * Shows the full Hermes agent roster:
 *   - Gateways (long-running Python processes serving the Telegram bots)
 *   - Profiles (specialist configurations Johnny5 spawns on demand)
 *   - Worker cron (the HQ task claimer; addressable: no)
 *
 * Click an addressable gateway to open a chat panel that streams
 * messages to/from that gateway's Telegram bot. Non-addressable
 * entries (specialist profiles) are display-only.
 */
export default function Agents() {
  const [roster, setRoster] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openChat, setOpenChat] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson('/agents');
      setRoster(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && !roster) {
    return <div className="p-6 text-slate-500">Loading roster…</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="card border-l-4 border-red-400 p-4 text-sm text-red-700">
          Failed to load roster: {error}
        </div>
      </div>
    );
  }

  const gateways = roster?.gateways || [];
  const profiles = roster?.profiles || [];
  const worker = roster?.worker_cron || {};

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-sm text-slate-500 mt-1">
            Hermes roster. Addressable gateways can be messaged directly. Specialist profiles are configurations Johnny5 uses on demand.
          </p>
        </div>
        <button onClick={load} className="btn-secondary text-sm flex items-center gap-1">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </header>

      <WorkerCronCard worker={worker} />

      <Section
        title="Gateways"
        subtitle="Long-running Hermes processes. Each one is addressable via its Telegram bot."
        icon={<Bot className="w-4 h-4" />}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {gateways.map((g) => (
            <GatewayCard
              key={g.id}
              agent={g}
              onOpenChat={() => setOpenChat(g.id)}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Specialist profiles"
        subtitle="Not addressable. Used by Johnny5 via the specialist-routing skill."
        icon={<Cpu className="w-4 h-4" />}
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {profiles.map((p) => (
            <ProfileCard key={p.id} agent={p} />
          ))}
        </div>
      </Section>

      {openChat && (
        <ChatPanel
          agentId={openChat}
          onClose={() => setOpenChat(null)}
        />
      )}
    </div>
  );
}

function Section({ title, subtitle, icon, children }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">{title}</h2>
        {icon}
      </div>
      {subtitle && <p className="text-xs text-slate-500 mb-3">{subtitle}</p>}
      {children}
    </section>
  );
}

function WorkerCronCard({ worker }) {
  const healthy = worker.healthy;
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div className={`w-2.5 h-2.5 rounded-full ${healthy ? 'bg-emerald-500' : 'bg-slate-300'}`} />
        <div>
          <div className="text-sm font-medium flex items-center gap-2">
            <Power className="w-4 h-4" /> Worker cron
            <span className={`text-xs ${healthy ? 'text-emerald-700' : 'text-slate-500'}`}>
              {healthy ? 'active' : 'idle'}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span>
              <strong>{worker.active_tasks || 0}</strong> running
            </span>
            <span>
              <strong>{worker.review_queue || 0}</strong> in review
            </span>
            <span>
              <strong>{worker.queued_tasks || 0}</strong> queued
            </span>
            {worker.last_heartbeat_at && (
              <span>last heartbeat: {relTime(worker.last_heartbeat_at)}</span>
            )}
            {worker.last_claim_at && (
              <span>last claim: {relTime(worker.last_claim_at)}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GatewayCard({ agent, onOpenChat }) {
  return (
    <div
      className={`card p-4 ${agent.addressable ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
      onClick={() => agent.addressable && onOpenChat()}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${agent.live ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <h3 className="font-medium">{agent.display_name}</h3>
            {agent.addressable && (
              <span className="text-xs text-blue-600 flex items-center gap-1">
                <MessageCircle className="w-3 h-3" /> chat
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono">{agent.model}</div>
          <div className="text-xs text-slate-400 mt-0.5">{agent.provider}{agent.api_mode ? ` · ${agent.api_mode}` : ''}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {agent.telegram_handle && (
          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{agent.telegram_handle}</span>
        )}
        {agent.etime && (
          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">uptime {agent.etime.split(/\s/)[0]}</span>
        )}
        {agent.pid && (
          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">pid {agent.pid}</span>
        )}
      </div>
      {agent.addressable && (
        <button
          className="mt-3 w-full text-xs btn-primary py-1.5"
          onClick={(e) => { e.stopPropagation(); onOpenChat(); }}
        >
          <MessageSquare className="w-3.5 h-3.5 inline mr-1" /> Open chat
        </button>
      )}
    </div>
  );
}

function ProfileCard({ agent }) {
  return (
    <div className="card p-3 opacity-80">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{agent.display_name}</div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">{agent.model}</div>
        </div>
        <span className="text-xs text-slate-400">stopped</span>
      </div>
    </div>
  );
}

function ChatPanel({ agentId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [info, setInfo] = useState(null);
  const pollRef = useRef(null);
  const scrollRef = useRef(null);

  // Poll for new messages every 3s while the panel is open.
  useEffect(() => {
    let cancelled = false;
    const loadHistory = async () => {
      try {
        const data = await fetchJson(`/agents/${agentId}/messages`);
        if (cancelled) return;
        setMessages(data.messages || []);
        setInfo(data.note || null);
        setHistoryLoaded(true);
      } catch (e) {
        setError(e.message);
      }
    };
    loadHistory();
    pollRef.current = setInterval(loadHistory, 3000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [agentId]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await postJson(`/agents/${agentId}/messages`, { text });
      setMessages((m) => [...m, {
        message_id: result.message_id,
        from: 'you',
        text,
        date: result.sent_at,
        direction: 'outbound',
      }]);
      setDraft('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-md bg-white shadow-xl flex flex-col">
        <header className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="font-semibold">Chat with {agentId}</h2>
            <p className="text-xs text-slate-500">via Telegram{agentId === 'default' ? ' @john5wizbot' : agentId === 'minimax' ? ' @john5minimaxbot' : ''}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            <X className="w-5 h-5" />
          </button>
        </header>

        {info && (
          <div className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
            {info}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {!historyLoaded && <div className="text-sm text-slate-500">Loading…</div>}
          {historyLoaded && messages.length === 0 && (
            <div className="text-sm text-slate-500 text-center mt-8">
              <Inbox className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              No messages yet. Send one to start the conversation.
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.message_id || `${m.date}-${m.from}`}
              className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  m.direction === 'outbound'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-800'
                }`}
              >
                <div className="text-xs opacity-75 mb-0.5">
                  {m.from === 'you' ? 'you' : m.from} · {relTime(m.date)}
                </div>
                <div className="whitespace-pre-wrap">{m.text}</div>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="px-4 py-2 text-xs text-red-700 bg-red-50 border-t border-red-100">
            {error}
          </div>
        )}

        <div className="p-3 border-t flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Type a message and press Enter…"
            className="flex-1 px-3 py-2 border rounded-md text-sm"
            disabled={sending}
            maxLength={4096}
          />
          <button
            onClick={send}
            disabled={!draft.trim() || sending}
            className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function relTime(iso) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  const delta = Date.now() - t;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
