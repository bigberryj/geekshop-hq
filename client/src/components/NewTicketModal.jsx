import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';

/**
 * NewTicketModal
 * - Pick an existing customer (search-as-you-type) OR create a new one inline
 * - Subject + optional body + priority
 * - Calls POST /api/tickets, then navigates to the new ticket
 *
 * Props:
 *   open, onClose
 */
export default function NewTicketModal({ open, onClose }) {
  const navigate = useNavigate();
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', email: '', company: '', phone: '' });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reset on open
  useEffect(() => {
    if (open) {
      setCustomerQuery('');
      setCustomerResults([]);
      setSelectedCustomer(null);
      setShowNewCustomer(false);
      setNewCustomer({ name: '', email: '', company: '', phone: '' });
      setSubject('');
      setBody('');
      setPriority('normal');
      setError('');
    }
  }, [open]);

  // Search customers
  useEffect(() => {
    if (!open) return;
    if (showNewCustomer) return;
    const q = customerQuery.trim();
    if (!q) {
      fetchJson('/customers').then(setCustomerResults).catch(() => setCustomerResults([]));
      return;
    }
    const handle = setTimeout(() => {
      fetchJson(`/customers?search=${encodeURIComponent(q)}`).then(setCustomerResults).catch(() => setCustomerResults([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [customerQuery, open, showNewCustomer]);

  if (!open) return null;

  const createCustomer = async (e) => {
    e?.preventDefault?.();
    setError('');
    if (!newCustomer.name.trim()) { setError('Customer name is required'); return; }
    setBusy(true);
    try {
      const created = await postJson('/customers', newCustomer);
      const customer = { id: created.id, ...newCustomer };
      setSelectedCustomer(customer);
      setShowNewCustomer(false);
      setCustomerQuery(newCustomer.name);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Customer create failed');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!selectedCustomer) { setError('Pick or create a customer first.'); return; }
    if (!subject.trim()) { setError('Subject is required.'); return; }
    setBusy(true);
    try {
      const result = await postJson('/tickets', {
        customer_id: selectedCustomer.id,
        subject: subject.trim(),
        body: body.trim(),
        priority,
      });
      onClose?.();
      navigate(`/tickets/${result.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Ticket create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">New ticket</h3>
          <button className="text-slate-500 hover:text-slate-900" onClick={onClose}>✕</button>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          {/* Customer picker */}
          <div>
            <label className="label">Customer</label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between border border-slate-200 rounded px-3 py-2">
                <div>
                  <div className="font-medium">{selectedCustomer.name}</div>
                  <div className="text-xs text-slate-500">{selectedCustomer.email || selectedCustomer.company || 'no email on file'}</div>
                </div>
                <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setSelectedCustomer(null)}>Change</button>
              </div>
            ) : showNewCustomer ? (
              <div className="border border-amber-200 bg-amber-50 rounded p-3 space-y-2">
                <div className="text-xs text-amber-800">New customer (not found in system)</div>
                <div className="grid grid-cols-2 gap-2">
                  <input className="input" placeholder="Name *" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} required />
                  <input className="input" placeholder="Email" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />
                  <input className="input" placeholder="Company" value={newCustomer.company} onChange={(e) => setNewCustomer({ ...newCustomer, company: e.target.value })} />
                  <input className="input" placeholder="Phone" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary text-sm" onClick={createCustomer} disabled={busy}>Create customer</button>
                  <button type="button" className="btn-ghost text-sm" onClick={() => setShowNewCustomer(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div>
                <input
                  className="input"
                  placeholder="Search customer by name, email, or company..."
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                />
                <div className="border border-slate-200 rounded mt-1 max-h-40 overflow-y-auto">
                  {customerResults.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-slate-500">No matches.</div>
                  ) : customerResults.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className="block w-full text-left px-3 py-2 hover:bg-slate-50 text-sm border-b border-slate-100 last:border-0"
                      onClick={() => setSelectedCustomer(c)}
                    >
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-slate-500">{c.email || ''}{c.company ? ` · ${c.company}` : ''}</div>
                    </button>
                  ))}
                </div>
                <button type="button" className="text-xs text-brand-600 hover:underline mt-1" onClick={() => setShowNewCustomer(true)}>
                  + Create new customer
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="label">Subject</label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short description" required />
          </div>
          <div>
            <label className="label">Details (optional)</label>
            <textarea className="input min-h-[100px]" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, what the customer said, etc." />
          </div>
          <div>
            <label className="label">Priority</label>
            <select className="input w-40" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          {error && <div className="rounded bg-red-50 border border-red-200 text-red-700 text-sm p-2">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || !selectedCustomer || !subject.trim()}>
              {busy ? 'Creating…' : 'Create ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
