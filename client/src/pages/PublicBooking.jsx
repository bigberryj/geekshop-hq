import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';

export default function PublicBooking() {
  const { slug = 'general' } = useParams();
  const [config, setConfig] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchJson(`/booking/${slug}`).then((cfg) => {
      setConfig(cfg);
      setSelectedSlot(cfg.available_slots?.[0] || null);
    }).catch((e) => setError(e.message));
  }, [slug]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!selectedSlot) {
      setError('Please pick an available time.');
      return;
    }
    setBusy(true);
    try {
      const res = await postJson(`/booking/${slug}`, {
        name: form.name,
        email: form.email,
        notes: form.notes,
        starts_at: selectedSlot.starts_at,
        ends_at: selectedSlot.ends_at,
      });
      setResult(res);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Booking failed');
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return <Shell><div className="card">Loading appointment times…</div></Shell>;
  }

  return (
    <Shell>
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <div className="text-sm uppercase tracking-wide text-brand-600 font-semibold">GeekShop Computers</div>
          <h1 className="text-4xl font-bold text-slate-900 mt-2">{config.title}</h1>
          <p className="text-slate-600 mt-3">{config.description}</p>
        </div>

        {result ? (
          <div className="card border-green-200 bg-green-50">
            <h2 className="text-xl font-semibold text-green-900">You're booked.</h2>
            <p className="text-green-800 mt-2">{result.message}</p>
            <p className="text-sm text-green-700 mt-2">If anything changes, reply to the confirmation email and Byron will sort it out.</p>
          </div>
        ) : (
          <form className="card space-y-5" onSubmit={submit}>
            <div>
              <label className="label">Choose a time</label>
              {config.available_slots?.length ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                  {config.available_slots.map((slot) => (
                    <button
                      type="button"
                      key={slot.starts_at}
                      onClick={() => setSelectedSlot(slot)}
                      className={`rounded border px-3 py-2 text-left text-sm ${selectedSlot?.starts_at === slot.starts_at ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <div className="font-medium">{slot.label}</div>
                      <div className="text-xs text-slate-500">90 minutes</div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500 mt-2">No public slots are currently available. Please email Byron directly.</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Your name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
              <Field label="Email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required />
            </div>
            <div>
              <label className="label">What do you need help with?</label>
              <textarea className="input min-h-[120px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Short description — networking, repair, website/domain, etc." />
            </div>

            {error && <div className="rounded bg-red-50 border border-red-200 text-red-700 text-sm p-3">{error}</div>}

            <button className="btn-primary w-full justify-center" disabled={busy || !config.available_slots?.length}>
              {busy ? 'Booking…' : 'Book this appointment'}
            </button>
            <p className="text-xs text-slate-500 text-center">No ticket number, no portal account. Just a normal appointment request.</p>
          </form>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return <div className="min-h-screen bg-slate-50 px-4 py-10">{children}</div>;
}

function Field({ label, value, onChange, type = 'text', required = false }) {
  return (
    <label>
      <span className="label">{label}</span>
      <input className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required} />
    </label>
  );
}
