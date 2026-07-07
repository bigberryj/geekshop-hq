import { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import SignatureWysiwyg from '../components/SignatureWysiwyg.jsx';

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
      <PageHeader title="Settings" />

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
          <select className="input w-full sm:w-80" value={settings.default_tax_model || 'gst_pst_bc'} onChange={(e) => update('default_tax_model', e.target.value)}>
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
        <h3 className="font-semibold mb-3">Outbound email signature</h3>
        <p className="text-xs text-slate-500 mb-3">
          Appended to every ticket reply sent to a customer ("Email customer" and "Reply &amp; resolve").
          Choose <b>Plain</b> for a simple text signature or <b>Rich</b> for the WYSIWYG editor
          (bold, links, images, basic tables). Leave empty to disable.
        </p>
        <SignatureEditor
          plainValue={settings.email_signature || ''}
          htmlValue={settings.email_signature_html || ''}
          format={settings.email_signature_format || 'plain'}
          onSavePlain={(v) => update('email_signature', v)}
          onSaveHtml={(v) => update('email_signature_html', v)}
          onSaveFormat={(v) => update('email_signature_format', v)}
        />
      </section>

      <section className="card mb-4">
        <h3 className="font-semibold mb-3">AI provider (two-tier)</h3>
        <p className="text-xs text-slate-500 mb-3">High-reasoning tasks (reply drafts, summary, extraction) use the provider below. Cheap/fast tasks (classification, nudges) use the other.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

function SignatureEditor({ plainValue, htmlValue, format, onSavePlain, onSaveHtml, onSaveFormat }) {
  const [mode, setMode] = useState(format === 'html' ? 'html' : 'plain');
  const [plain, setPlain] = useState(plainValue || '');
  const [html, setHtml] = useState(htmlValue || '');
  useEffect(() => { setPlain(plainValue || ''); }, [plainValue]);
  useEffect(() => { setHtml(htmlValue || ''); }, [htmlValue]);
  useEffect(() => { setMode(format === 'html' ? 'html' : 'plain'); }, [format]);

  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    onSaveFormat(next);
  };

  // Sanitize a small allowlist in the preview so the live preview is
  // safe to render with dangerouslySetInnerHTML. The server applies the
  // same allowlist before sending. Mirrors server/lib/signature.js
  // sanitizeRichSignature — keep them in sync.
  const sanitizePreview = (raw) => {
    if (!raw) return '';
    // Drop script/style/iframe/object/embed/form/link/meta/base entirely
    let s = String(raw)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');
    // Strip on* event handlers
    s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
    // Strip javascript: / data: / vbscript: in href/src
    s = s.replace(/(\s(?:href|src)\s*=\s*")\s*(?:javascript|data|vbscript|file):[^"]*"/gi, '$1#"');
    s = s.replace(/(\s(?:href|src)\s*=\s*')\s*(?:javascript|data|vbscript|file):[^']*'/gi, "$1#'");
    s = s.replace(/(\s(?:href|src)\s*=\s*)(?:javascript|data|vbscript|file):[^\s>]+/gi, '$1#');
    return s;
  };

  const sample = `Hi Linda — coming out tomorrow to assess the firewall. I have a 10am-11:30am slot open if that works.`;

  return (
    <div className="max-w-2xl">
      <div className="mb-2 flex items-center gap-2">
        <label className="label !mb-0">Format:</label>
        <div className="inline-flex rounded border border-slate-300 overflow-hidden text-xs">
          <button
            type="button"
            className={`px-3 py-1 ${mode === 'plain' ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
            onClick={() => switchMode('plain')}
            data-testid="sig-mode-plain"
          >Plain text</button>
          <button
            type="button"
            className={`px-3 py-1 ${mode === 'html' ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
            onClick={() => switchMode('html')}
            data-testid="sig-mode-html"
          >Rich (HTML)</button>
        </div>
        <span className="text-xs text-slate-500">Changes save on switch.</span>
      </div>

      {mode === 'plain' ? (
        <div>
          <label className="label">Signature (plain text)</label>
          <textarea
            className="input font-mono text-xs"
            rows={5}
            value={plain}
            onChange={(e) => setPlain(e.target.value)}
            onBlur={() => onSavePlain(plain)}
            placeholder={'Byron Berry\nGeekShop Computers\nbyron@geekshop.ca · 250-555-0100'}
            data-testid="sig-plain-input"
          />
          <div className="flex gap-2 mt-2">
            <button className="btn-secondary" onClick={() => onSavePlain(plain)}>Save</button>
            <span className="self-center text-xs text-slate-500">Saves on blur or button click.</span>
          </div>
          <div className="mt-3">
            <div className="text-xs text-slate-500 mb-1">Live preview (sample reply + your signature):</div>
            <pre
              className="text-xs bg-slate-50 border border-slate-200 rounded p-3 whitespace-pre-wrap font-mono"
              data-testid="signature-preview"
            >{plain.trim() ? `${sample}\n\n--\n${plain}` : sample}</pre>
          </div>
        </div>
      ) : (
        <div>
          <label className="label">Signature (rich)</label>
          <p className="text-xs text-slate-500 mb-2">
            Use the toolbar to format your signature (bold, italic, lists, links, images).
            Allowed tags: a, b, strong, i, em, u, span, div, p, br, img, h1–h6, ul, ol, li, table, tr, th, td.
            <br />
            <code>href</code>/<code>src</code> must use <code>http(s)</code> or <code>mailto</code>. Anything else is stripped on save.
            Press <kbd className="px-1 py-0.5 bg-white border border-slate-300 rounded text-[10px]">Ctrl/Cmd-S</kbd> to save.
          </p>
          <SignatureWysiwyg
            value={html}
            onSave={(v) => { setHtml(v); onSaveHtml(v); }}
            onCancel={() => setHtml(htmlValue || '')}
          />
          <div className="mt-3">
            <div className="text-xs text-slate-500 mb-1">Email preview (rendered HTML — what customers will see):</div>
            <div
              className="text-sm bg-slate-50 border border-slate-200 rounded p-3"
              dangerouslySetInnerHTML={{
                __html: html.trim()
                  ? `${sample}<div style="margin-top:1em;padding-top:0.75em;border-top:1px solid #e5e7eb;color:#475569;font-size:0.9em">${sanitizePreview(html)}</div>`
                  : `<span class="text-slate-400">${sample}</span>`,
              }}
              data-testid="signature-preview"
            />
          </div>
        </div>
      )}
    </div>
  );
}
