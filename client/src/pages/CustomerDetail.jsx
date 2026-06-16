import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchJson, postJson, putJson, delJson, formatDuration, formatMoney } from '../lib/api.js';
import { Sparkles, Plus, Trash2, Pencil, X, Check, Loader2 } from 'lucide-react';

const CATEGORIES = ['preference', 'equipment', 'history', 'relationship', 'note'];

function EditableContact({ customer, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: customer.name || '',
    company: customer.company || '',
    email: customer.email || '',
    phone: customer.phone || '',
    notes: customer.notes || '',
  });

  // Reset form when customer data changes (e.g. after save).
  useEffect(() => {
    if (!editing) {
      setForm({
        name: customer.name || '',
        company: customer.company || '',
        email: customer.email || '',
        phone: customer.phone || '',
        notes: customer.notes || '',
      });
    }
  }, [customer, editing]);

  const start = () => { setError(''); setEditing(true); };
  const cancel = () => { setError(''); setEditing(false); };
  const save = async (e) => {
    e?.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Only send fields that actually changed so the audit log is clean.
      const changed = {};
      for (const k of Object.keys(form)) {
        const prev = (customer[k] || '') + '';
        const next = (form[k] || '') + '';
        if (prev !== next) changed[k] = form[k];
      }
      if (Object.keys(changed).length === 0) {
        setEditing(false);
        return;
      }
      await putJson(`/customers/${customer.id}`, changed);
      setEditing(false);
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="mt-2 mb-6">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold">{customer.name}</h2>
            <div className="text-sm text-slate-500 mt-1">
              {[
                customer.company,
                customer.email,
                customer.phone,
              ].filter(Boolean).join(' · ') || <span className="italic text-slate-400">no contact info yet</span>}
            </div>
            {customer.notes && <p className="text-sm text-slate-700 mt-2 whitespace-pre-wrap">{customer.notes}</p>}
          </div>
          <button
            onClick={start}
            className="btn-secondary text-xs shrink-0"
            data-testid="customer-edit-btn"
            title="Edit contact info"
          >
            <Pencil size={12} /> Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mt-2 mb-6 card border-amber-300 bg-amber-50/50">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Edit contact info</h3>
        <div className="flex gap-2">
          <button type="button" onClick={cancel} disabled={saving} className="btn-ghost text-xs" data-testid="customer-edit-cancel">
            <X size={12} /> Cancel
          </button>
          <button type="submit" disabled={saving} className="btn-primary text-xs" data-testid="customer-edit-save">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs">
          <span className="text-slate-500">Name *</span>
          <input className="input mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="customer-edit-name" />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Company</span>
          <input className="input mt-1" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} data-testid="customer-edit-company" />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Email</span>
          <input type="email" className="input mt-1" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="customer-edit-email" />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Phone</span>
          <input className="input mt-1" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} data-testid="customer-edit-phone" />
        </label>
      </div>
      <label className="text-xs block mt-3">
        <span className="text-slate-500">Notes</span>
        <textarea className="input mt-1 min-h-[80px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} data-testid="customer-edit-notes" />
      </label>
    </form>
  );
}

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
      <EditableContact customer={c} onSaved={load} />
      <div className="mt-3 text-sm">
        <span className="badge-slate mr-2">Total time: {formatDuration(c.total_time_seconds)}</span>
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
