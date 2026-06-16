import { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../lib/api.js';

const TAX_MODELS = [
  { key: 'none', label: 'No tax' },
  { key: 'gst', label: 'GST 5% (federal only)' },
  { key: 'gst_pst_bc', label: 'BC: GST 5% + PST 7%' },
  { key: 'gst_qst_qc', label: 'QC: GST 5% + QST 9.975%' },
  { key: 'hst_on_13', label: 'HST 13% (Ontario)' },
  { key: 'hst_nb_ns_pe_15', label: 'HST 15% (NB / NS / PE)' },
];

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [testResults, setTestResults] = useState({});

  const load = () => fetchJson('/settings').then(setSettings);
  useEffect(() => { load(); }, []);

  const update = async (key, value) => {
    await putJson(`/settings/${key}`, { value });
    load();
  };

  const testAI = async (provider) => {
    const r = await postJson(`/settings/test-ai/${provider}`, {});
    setTestResults({ ...testResults, [provider]: r });
  };

  // Labour rate is stored as cents/hour. UI shows $/hr.
  // Local state so the field doesn't ping the API on every keystroke;
  // commit on blur or Enter.
  const [rateDraft, setRateDraft] = useState('');
  useEffect(() => {
    const v = Number(settings.labour_rate_cents_per_hour);
    setRateDraft(Number.isFinite(v) ? (v / 100).toFixed(2) : '100.00');
  }, [settings.labour_rate_cents_per_hour]);
  const commitRate = () => {
    const cents = Math.round(Number(rateDraft) * 100);
    if (Number.isFinite(cents) && cents >= 0) update('labour_rate_cents_per_hour', String(cents));
  };

  // Same pattern for the minimum charge. 0 = off.
  const [minDraft, setMinDraft] = useState('');
  useEffect(() => {
    const v = Number(settings.minimum_charge_cents);
    setMinDraft(Number.isFinite(v) ? (v / 100).toFixed(2) : '0.00');
  }, [settings.minimum_charge_cents]);
  const commitMin = () => {
    const cents = Math.round(Number(minDraft) * 100);
    if (Number.isFinite(cents) && cents >= 0) update('minimum_charge_cents', String(cents));
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <section className="card mb-4">
        <h3 className="font-semibold mb-3">Business</h3>
        <Field label="Business name" value={settings.business_name || ''} onSave={(v) => update('business_name', v)} />
        <Field label="Business email (shown on invoices)" value={settings.business_email || ''} onSave={(v) => update('business_email', v)} />
        <Field label="Public booking slug" value={settings.booking_slug || 'general'} onSave={(v) => update('booking_slug', v)} />
        <p className="text-xs text-slate-500 mt-2">Booking page URL: <a className="text-brand-600 hover:underline" href={`/book/${settings.booking_slug || 'general'}`} target="_blank">/book/{settings.booking_slug || 'general'}</a></p>
      </section>

      <section className="card mb-4">
        <h3 className="font-semibold mb-3">Billing & tax</h3>
        <p className="text-xs text-slate-500 mb-3">Default tax model applies to every new invoice. You can override per-invoice at creation time.</p>
        <div className="mb-2">
          <label className="label">Default tax model</label>
          <select className="input w-80" value={settings.default_tax_model || 'gst_pst_bc'} onChange={(e) => update('default_tax_model', e.target.value)}>
            {TAX_MODELS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="mb-2 max-w-xs">
          <label className="label">Labour rate ($/hr CAD)</label>
          <div className="flex gap-2">
            <input
              className="input"
              type="number"
              step="0.01"
              min="0"
              value={rateDraft}
              onChange={(e) => setRateDraft(e.target.value)}
              onBlur={commitRate}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            />
            <span className="self-center text-xs text-slate-500">/hr</span>
          </div>
          <p className="text-xs text-slate-500 mt-1">Used when "draft from time entries" is clicked on the Money page. Stored as {settings.labour_rate_cents_per_hour || '10000'} cents/hr.</p>
        </div>
        <div className="mb-2 max-w-xs">
          <label className="label">
            Minimum charge floor ($ CAD) <span className="text-xs text-slate-500">— private, never shown to customers</span>
          </label>
          <div className="flex gap-2">
            <input
              className="input"
              type="number"
              step="0.01"
              min="0"
              value={minDraft}
              onChange={(e) => setMinDraft(e.target.value)}
              onBlur={commitMin}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            />
            <span className="self-center text-xs text-slate-500">per invoice</span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            When a draft from time entries is below this amount, the labour lines are silently re-priced up to the floor.
            The customer sees a clean invoice with normal line items. Set to $0.00 to disable.
            Currently {settings.minimum_charge_cents ? `${settings.minimum_charge_cents} cents` : 'disabled'}.
          </p>
        </div>
      </section>

      <section className="card mb-4">
        <h3 className="font-semibold mb-3">Gmail moderation (junk classifier)</h3>
        <p className="text-xs text-slate-500 mb-3">
          These three settings tune the rules-first junk classifier without editing code.
          The classifier runs on every Gmail scan, plus a one-shot backfill on the legacy
          queue from the Inbox page. All three fields are private/admin-only.
        </p>

        <ListField
          label="Auto-dismiss domains"
          hint="Comma-separated. Each adds 0.6 to the score. Used for senders that are always junk (marketing, app promos, etc.). Example: mail.cargurus.com, googlenews-noreply.google.com"
          value={settings.auto_dismiss_domains || ''}
          onSave={(v) => update('auto_dismiss_domains', v)}
        />

        <ListField
          label="Always-keep subjects"
          hint="Comma-separated substrings. Subjects matching ANY of these are NEVER auto-dismissed, even if the sender is a noreply@. Used for security alerts, account-recovery, etc."
          value={settings.auto_keep_subjects || ''}
          onSave={(v) => update('auto_keep_subjects', v)}
        />

        <ListField
          label="Agent mailbox(es)"
          hint="Comma-separated from_email values. Mail from these addresses is operational agent traffic. It stays in the queue by default; the Inbox UI's 'Hide agent mail' toggle hides them from the human-pending view."
          value={settings.agent_mailbox_from || 'johnn5wizbot@gmail.com'}
          onSave={(v) => update('agent_mailbox_from', v)}
        />
      </section>

      <section className="card mb-4">
        <h3 className="font-semibold mb-3">AI provider (two-tier)</h3>
        <p className="text-xs text-slate-500 mb-3">High-reasoning tasks (reply drafts, summary, extraction) use the provider below. Cheap/fast tasks (classification, nudges) use the other.</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">High-reasoning</label>
            <div className="flex gap-2">
              <select className="input" value={settings.ai_high_provider || 'minimax'} onChange={(e) => update('ai_high_provider', e.target.value)}>
                <option value="minimax">Johnny5 (MiniMax)</option>
                <option value="codex">Codex (ChatGPT sub)</option>
                <option value="gemini">Gemini (optional)</option>
              </select>
              <button className="btn-secondary" onClick={() => testAI(settings.ai_high_provider || 'minimax')}>Test</button>
            </div>
            {testResults[settings.ai_high_provider || 'minimax'] && (
              <div className="text-xs mt-1 text-slate-600">
                {testResults[settings.ai_high_provider || 'minimax'].ok ? `✓ ${testResults[settings.ai_high_provider || 'minimax'].latency_ms}ms` : `✗ ${testResults[settings.ai_high_provider || 'minimax'].error}`}
              </div>
            )}
          </div>
          <div>
            <label className="label">Cheap / fast</label>
            <div className="flex gap-2">
              <select className="input" value={settings.ai_cheap_provider || 'minimax'} onChange={(e) => update('ai_cheap_provider', e.target.value)}>
                <option value="minimax">Johnny5 (MiniMax)</option>
                <option value="codex">Codex (ChatGPT sub)</option>
                <option value="gemini">Gemini (optional)</option>
              </select>
              <button className="btn-secondary" onClick={() => testAI(settings.ai_cheap_provider || 'minimax')}>Test</button>
            </div>
            {testResults[settings.ai_cheap_provider || 'minimax'] && (
              <div className="text-xs mt-1 text-slate-600">
                {testResults[settings.ai_cheap_provider || 'minimax'].ok ? `✓ ${testResults[settings.ai_cheap_provider || 'minimax'].latency_ms}ms` : `✗ ${testResults[settings.ai_cheap_provider || 'minimax'].error}`}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h3 className="font-semibold mb-3">Email (SMTP)</h3>
        <Field label="SMTP host" value={settings.smtp_host || ''} onSave={(v) => update('smtp_host', v)} />
        <Field label="SMTP user" value={settings.smtp_user || ''} onSave={(v) => update('smtp_user', v)} />
        <Field label="SMTP pass" value={settings.smtp_pass || ''} onSave={(v) => update('smtp_pass', v)} type="password" />
        <p className="text-xs text-slate-500 mt-2">Set these in <code>.env</code> for production. Dev mode logs to console.</p>
      </section>
    </div>
  );
}

function Field({ label, value, onSave, type = 'text' }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <div className="mb-2">
      <label className="label">{label}</label>
      <div className="flex gap-2">
        <input className="input" type={type} value={v} onChange={(e) => setV(e.target.value)} />
        <button className="btn-secondary" onClick={() => onSave(v)}>Save</button>
      </div>
    </div>
  );
}

function ListField({ label, hint, value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <div className="mb-3 max-w-2xl">
      <label className="label">{label}</label>
      <div className="flex gap-2">
        <input className="input font-mono text-xs" value={v} onChange={(e) => setV(e.target.value)} placeholder="comma,separated,list" />
        <button className="btn-secondary" onClick={() => onSave(v)}>Save</button>
      </div>
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}
