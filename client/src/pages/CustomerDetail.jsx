import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchJson, postJson, delJson, formatDuration, formatMoney } from '../lib/api.js';
import { Sparkles, Plus, Trash2 } from 'lucide-react';

const CATEGORIES = ['preference', 'equipment', 'history', 'relationship', 'note'];

export default function CustomerDetail() {
  const { id } = useParams();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('tickets');
  const [newMem, setNewMem] = useState({ category: 'note', key: '', value: '' });
  const [extractText, setExtractText] = useState('');
  const [extracting, setExtracting] = useState(false);

  const load = () => fetchJson(`/customers/${id}`).then(setC);
  useEffect(() => { load(); }, [id]);

  if (!c) return <div>Loading…</div>;

  const addMemory = async (e) => {
    e.preventDefault();
    await postJson(`/customers/${id}/memory`, newMem);
    setNewMem({ category: 'note', key: '', value: '' });
    load();
  };

  const delMemory = async (mid) => {
    if (!confirm('Delete this memory entry?')) return;
    await delJson(`/customers/${id}/memory/${mid}`);
    load();
  };

  const extract = async () => {
    if (!extractText) return;
    setExtracting(true);
    try {
      const r = await postJson(`/customers/${id}/memory/extract`, { notes: extractText });
      alert(`Extracted ${r.count} entries (provider: ${r.provider})`);
      setExtractText('');
      load();
    } finally { setExtracting(false); }
  };

  return (
    <div>
      <Link to="/customers" className="text-sm text-slate-500 hover:underline">← All customers</Link>
      <div className="mt-2 mb-6">
        <h2 className="text-2xl font-bold">{c.name}</h2>
        <div className="text-sm text-slate-500">{c.company} · {c.email} · {c.phone}</div>
        {c.notes && <p className="text-sm text-slate-700 mt-2">{c.notes}</p>}
        <div className="mt-3 text-sm">
          <span className="badge-slate mr-2">Total time: {formatDuration(c.total_time_seconds)}</span>
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200 mb-4">
        {['tickets', 'memory', 'invoices'].map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === t ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500'}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'memory' && c.memory.length > 0 && <span className="ml-1 text-xs text-slate-400">({c.memory.length})</span>}
          </button>
        ))}
      </div>

      {tab === 'tickets' && (
        <div className="card">
          {c.tickets.length === 0 ? <p className="text-slate-500 text-sm">No tickets yet.</p> : (
            <ul className="space-y-2">
              {c.tickets.map((t) => (
                <li key={t.id} className="flex items-center justify-between text-sm">
                  <Link to={`/tickets/${t.id}`} className="text-brand-600 hover:underline">{t.subject}</Link>
                  <span className={`badge-${t.status === 'resolved' ? 'slate' : 'green'}`}>{t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'memory' && (
        <div className="space-y-4">
          <form onSubmit={addMemory} className="card grid grid-cols-3 gap-2">
            <select className="input" value={newMem.category} onChange={(e) => setNewMem({ ...newMem, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <input className="input" placeholder="key (optional)" value={newMem.key} onChange={(e) => setNewMem({ ...newMem, key: e.target.value })} />
            <div className="flex gap-2">
              <input className="input flex-1" placeholder="value" value={newMem.value} onChange={(e) => setNewMem({ ...newMem, value: e.target.value })} required />
              <button className="btn-primary" type="submit"><Plus size={14} /></button>
            </div>
          </form>

          <div className="card">
            <h4 className="font-semibold text-sm mb-2 flex items-center gap-2"><Sparkles size={14} /> Bulk extract from notes</h4>
            <textarea className="input min-h-[80px] mb-2" placeholder="Paste freeform notes here. AI will extract structured memory entries (confidence 0.7)." value={extractText} onChange={(e) => setExtractText(e.target.value)} />
            <button className="btn-primary" onClick={extract} disabled={extracting || !extractText}>{extracting ? 'Extracting…' : 'Extract with AI'}</button>
          </div>

          <div className="card">
            <h4 className="font-semibold text-sm mb-3">Memory entries</h4>
            {c.memory.length === 0 ? <p className="text-slate-500 text-sm">None yet.</p> : (
              <ul className="space-y-2">
                {c.memory.map((m) => (
                  <li key={m.id} className="flex items-start justify-between text-sm border-b pb-2 last:border-0">
                    <div>
                      <span className="badge-yellow mr-2">{m.category}</span>
                      {m.key && <span className="font-mono text-xs text-slate-500 mr-2">{m.key}:</span>}
                      <span>{m.value}</span>
                      <span className="text-xs text-slate-400 ml-2">({m.source}, conf {m.confidence})</span>
                    </div>
                    <button onClick={() => delMemory(m.id)} className="text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'invoices' && (
        <div className="card">
          {c.invoices.length === 0 ? <p className="text-slate-500 text-sm">No invoices yet.</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th>ID</th><th>Status</th><th>Total</th><th>Sent</th><th>Due</th><th>Paid</th></tr>
              </thead>
              <tbody>
                {c.invoices.map((i) => (
                  <tr key={i.id} className="border-t">
                    <td className="py-1.5 font-mono text-xs">{i.invoice_uid}</td>
                    <td><span className={`badge-${i.status === 'paid' ? 'green' : i.status === 'overdue' ? 'red' : 'yellow'}`}>{i.status}</span></td>
                    <td className="font-mono">{formatMoney(i.total_cents)}</td>
                    <td className="text-xs">{i.sent_at || '—'}</td>
                    <td className="text-xs">{i.due_at || '—'}</td>
                    <td className="text-xs">{i.paid_at || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
