import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  fetchJson, postJson, putJson, delJson, formatMoney, api,
} from '../lib/api.js';
import {
  LayoutDashboard, FileText, Users, Package, Percent,
  Receipt, CreditCard, BarChart3, Upload, Database,
  Plus, X, Edit3, Trash2, Save, Search, Filter,
  ChevronRight, CheckCircle2, AlertCircle, Clock, Download,
  FileUp, RotateCcw, Archive, Send, DollarSign, Eye, EyeOff,
  ScrollText, Timer, FileWarning, UserMinus, ExternalLink,
  Calculator, FileSpreadsheet, Printer,
  Camera, RefreshCw, ImageIcon, ScanLine, AlertTriangle,
} from 'lucide-react';

// ============== Receipt capture (webcam + file picker) ==============
//
// Phase 4+ — webcam receipt capture for the expense editor.
//
// Why this exists: Byron asked "can we use a camera or the webcam from
// the browser to capture and read receipts and input them into our
// expenses?" — yes, we can, and we can build it ourselves with the
// standard MediaDevices / Canvas APIs (no third-party libs, no paid
// OCR service for the first cut).
//
// What this component does:
//   1. Requests camera permission via navigator.mediaDevices.getUserMedia
//   2. Shows a live <video> preview inside a modal-scoped panel
//   3. On "Snap", draws the current frame into an offscreen <canvas>,
//      converts it to a JPEG Blob via canvas.toBlob(), and calls
//      onCapture(blob, filename)
//   4. Provides a "Retake" path and a fallback file picker
//
// Why JPEG, not PNG: webcam frames are noisy and large; JPEG at 0.85
// quality gives ~10× smaller files for the same legibility. JPEG is on
// the server's existing receipt allowlist (lib/attachments.js) so no
// server change is needed.
//
// Why we do NOT do OCR here: the user asked specifically whether we
// CAN capture and read receipts. We can capture cleanly with browser
// APIs; the "read" part is a separate question (Tesseract.js is the
// obvious self-hosted option, but it's a Phase 5+ task that adds
// ~2 MB to the bundle and another dependency to audit). For now this
// component captures and attaches the JPEG so it lives with the
// expense; an "OCR" toggle is documented in security.md as deferred.
//
// Security notes:
//   - The MediaDevices permission prompt is browser-native and user-
//     visible; we never touch the stream from outside the user's tab.
//   - We stop every track on unmount and on capture (frees the camera
//     light immediately, prevents background-stream leaks).
//   - We never persist the stream — only one frame at a time, in JS
//     memory, and we hand the Blob to the parent's uploadReceipt().
//   - All admin gating is the parent's responsibility (this component
//     is only mounted from ExpenseEditor which already sits behind
//     requireAdmin on the server).
function ReceiptCapture({ onCapture, disabled }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [starting, setStarting] = useState(false);
  const [captured, setCaptured] = useState(null); // { dataUrl, blob, ts }
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  // Tear down the stream whenever this component unmounts. Critical
  // for not leaving the camera light on after the modal closes.
  useEffect(() => {
    return () => stopStream(stream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCamera = async () => {
    setErr('');
    setStarting(true);
    setCaptured(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('This browser does not support webcam capture.');
      }
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      setStream(s);
      // The <video> element mounts on the next render — wait one tick.
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.play().catch(() => { /* autoplay can race; user clicks Snap */ });
        }
      }, 0);
    } catch (e) {
      setErr(e?.message || 'Could not access the webcam.');
    } finally {
      setStarting(false);
    }
  };

  const stopStream = (s) => {
    if (!s) return;
    try { s.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  };

  const snap = () => {
    setErr('');
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) { setErr('Camera not ready.'); return; }
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) { setErr('Canvas not available.'); return; }
    ctx.drawImage(v, 0, 0, w, h);
    c.toBlob((blob) => {
      if (!blob) { setErr('Failed to encode frame.'); return; }
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      setCaptured({ dataUrl, blob, ts: Date.now() });
      // Free the camera immediately so the green light goes off.
      stopStream(stream);
      setStream(null);
    }, 'image/jpeg', 0.85);
  };

  const retake = async () => {
    setCaptured(null);
    setErr('');
    await startCamera();
  };

  const acceptCapture = () => {
    if (!captured) return;
    const ts = new Date(captured.ts);
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
    const file = new File([captured.blob], `receipt-${stamp}.jpg`, { type: 'image/jpeg' });
    onCapture(file);
    setCaptured(null);
  };

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (f) onCapture(f);
    // Reset so re-selecting the same file still fires onChange.
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <Camera size={14} className="text-slate-500" />
        <span>Capture with webcam or phone camera, or pick a file below.</span>
      </div>

      {!stream && !captured && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={startCamera}
            disabled={disabled || starting}
            data-testid="expense-receipt-start-camera"
          >
            <Camera size={14} /> {starting ? 'Starting…' : 'Use webcam'}
          </button>
          <span className="text-xs text-slate-500">or</span>
          <label className={`btn-secondary cursor-pointer ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
            <ImageIcon size={14} /> Pick image / PDF
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              onChange={onPickFile}
              className="hidden"
              data-testid="expense-receipt-file-input"
            />
          </label>
        </div>
      )}

      {stream && (
        <div className="border border-slate-200 rounded p-2 bg-black/95">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full max-h-72 object-contain bg-black"
            data-testid="expense-receipt-video"
          />
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              className="btn-primary"
              onClick={snap}
              data-testid="expense-receipt-snap"
            >
              <ScanLine size={14} /> Snap receipt
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { stopStream(stream); setStream(null); setErr(''); }}
            >
              Cancel
            </button>
            <span className="text-xs text-slate-300 ml-auto self-center">
              Tip: hold the receipt flat and well-lit before snapping.
            </span>
          </div>
        </div>
      )}

      {captured && (
        <div className="border border-slate-200 rounded p-2 bg-slate-50">
          <img
            src={captured.dataUrl}
            alt="Captured receipt preview"
            className="w-full max-h-72 object-contain bg-white"
            data-testid="expense-receipt-preview"
          />
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              className="btn-primary"
              onClick={acceptCapture}
              disabled={disabled}
              data-testid="expense-receipt-accept"
            >
              <Save size={14} /> Use this photo
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={retake}
              disabled={disabled}
              data-testid="expense-receipt-retake"
            >
              <RefreshCw size={14} /> Retake
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setCaptured(null)}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{err}</span>
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}

// ============== helpers ==============

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function ymStart() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
function dollarsToCents(s) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function centsToDollars(c) {
  if (c == null) return '';
  return (c / 100).toFixed(2);
}
function bpsToPercent(bps) {
  if (bps == null) return '';
  return (Number(bps) / 100).toFixed(2);
}
function percentToBps(s) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fmtDate(s) {
  if (!s) return '—';
  return s.slice(0, 10);
}
function fmtDateTime(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString();
  } catch { return s; }
}

function statusBadge(status) {
  const cls = {
    paid: 'badge-green',
    overdue: 'badge-red',
    draft: 'badge-slate',
    sent: 'badge-yellow',
    cancelled: 'badge-slate',
    viewed: 'badge-yellow',
    succeeded: 'badge-green',
    pending: 'badge-yellow',
    failed: 'badge-red',
    refunded: 'badge-slate',
  }[status] || 'badge-slate';
  return <span className={cls}>{status}</span>;
}

function moneyColor(c) {
  if (c == null) return '';
  if (c < 0) return 'text-red-600';
  if (c > 0) return 'text-green-700';
  return 'text-slate-700';
}

// ============== main component ==============

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'invoices', label: 'Invoices', icon: FileText },
  { key: 'customers', label: 'Customers', icon: Users },
  { key: 'products', label: 'Products & Services', icon: Package },
  { key: 'taxes', label: 'Tax Rates', icon: Percent },
  { key: 'expenses', label: 'Expenses', icon: Receipt },
  { key: 'categories', label: 'Categories', icon: Package },
  { key: 'payments', label: 'Payments', icon: CreditCard },
  { key: 'tax-summary', label: 'Tax Summary', icon: Calculator },
  { key: 'export', label: 'Accountant Export', icon: FileSpreadsheet },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'audit', label: 'Audit Log', icon: ScrollText },
  { key: 'import', label: 'Import (QBO/CSV)', icon: Upload },
  { key: 'backups', label: 'Backups', icon: Database },
];

export default function Accounting() {
  const [tab, setTab] = useState('dashboard');
  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">Accounting</h2>
      <p className="text-xs text-slate-500 mb-4">
        Solo business accounting. Invoices, expenses, taxes, payments, reports.
      </p>

      <div className="flex flex-wrap gap-1 mb-4 border-b border-slate-200 overflow-x-auto">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
              tab === key
                ? 'border-brand-600 text-brand-700 font-semibold'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'customers' && <CustomersTab />}
      {tab === 'products' && <ProductsTab />}
      {tab === 'taxes' && <TaxRatesTab />}
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'tax-summary' && <TaxSummaryTab />}
      {tab === 'export' && <ExportTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'import' && <ImportTab />}
      {tab === 'backups' && <BackupsTab />}
    </div>
  );
}

// ============== Dashboard ==============

// Phase 1 — Revenue leakage panel.
// Five widget cards that surface the buckets named in the billing
// roadmap so the operator can see them on first load of the Accounting
// page instead of digging through reports + customers + invoices.
function LeakagePanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [staleDraftDays, setStaleDraftDays] = useState(14);
  const [staleInvoiceDays, setStaleInvoiceDays] = useState(30);

  const load = async () => {
    try {
      const qs = `?stale_draft_days=${staleDraftDays}&stale_invoice_days=${staleInvoiceDays}`;
      const d = await fetchJson(`/accounting/leakage${qs}`);
      setData(d);
      setErr('');
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [staleDraftDays, staleInvoiceDays]);

  if (err) return <div className="card text-red-600 mb-4">{err}</div>;
  if (!data) return <div className="card mb-4">Loading leakage dashboard…</div>;

  const { uninvoiced_time, resolved_tickets_with_uninvoiced_time,
          stale_draft_invoices, overdue_sent_invoices, dormant_customers } = data;

  const totalLeakageCents =
    (uninvoiced_time?.total_cents || 0) +
    (resolved_tickets_with_uninvoiced_time?.total_cents || 0) +
    (stale_draft_invoices?.total_cents || 0) +
    (overdue_sent_invoices?.total_cents || 0);

  return (
    <section className="card mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="font-semibold flex items-center gap-1.5">
            <AlertCircle size={14} className="text-orange-600" />
            Revenue leakage
          </h3>
          <p className="text-xs text-slate-500">
            Billable work and cash leaks that need attention. Total potential:&nbsp;
            <span className="font-mono font-semibold text-slate-700">{formatMoney(totalLeakageCents)}</span>
            {data.params?.labour_rate_cents_per_hour ? (
              <span className="text-slate-400"> · valued at ${(data.params.labour_rate_cents_per_hour / 100).toFixed(0)}/h</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <label className="flex items-center gap-1">
            Stale drafts &gt;
            <input
              type="number" min="1" max="365" className="input !w-16 !py-0.5 !text-xs"
              value={staleDraftDays}
              onChange={(e) => setStaleDraftDays(Math.max(1, Math.min(365, Number(e.target.value) || 14)))}
            />
            d
          </label>
          <label className="flex items-center gap-1">
            No invoice in &gt;
            <input
              type="number" min="1" max="365" className="input !w-16 !py-0.5 !text-xs"
              value={staleInvoiceDays}
              onChange={(e) => setStaleInvoiceDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))}
            />
            d
          </label>
          <button className="btn-ghost text-xs" onClick={load} title="Refresh">↻</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <LeakageCard
          title="Uninvoiced time" icon={Timer}
          valueText={formatMoney(uninvoiced_time.total_cents)}
          subText={`${uninvoiced_time.count} entr${uninvoiced_time.count === 1 ? 'y' : 'ies'} · top ${uninvoiced_time.by_ticket.length} ticket${uninvoiced_time.by_ticket.length === 1 ? '' : 's'}`}
          empty={uninvoiced_time.count === 0}
          emptyText="All billable time has been invoiced."
          color="text-amber-700"
        >
          <ul className="text-xs space-y-1 mt-2 max-h-40 overflow-y-auto">
            {uninvoiced_time.by_ticket.slice(0, 5).map((g) => (
              <li key={g.ticket_id} className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1">
                <a className="hover:underline truncate flex-1" href={`/tickets/${g.ticket_id}`}>
                  <span className="font-mono text-slate-500">{g.ticket_uid}</span>
                  <span className="ml-1">{g.ticket_subject || 'untitled'}</span>
                  {g.ticket_status === 'resolved' ? <span className="badge-green !text-[10px] ml-1">resolved</span> : null}
                  {g.has_running ? <span className="badge-yellow !text-[10px] ml-1">running</span> : null}
                </a>
                <span className="font-mono text-amber-700 whitespace-nowrap">{formatMoney(g.value_cents)}</span>
              </li>
            ))}
          </ul>
        </LeakageCard>

        <LeakageCard
          title="Resolved with unbilled time" icon={CheckCircle2}
          valueText={formatMoney(resolved_tickets_with_uninvoiced_time.total_cents)}
          subText={`${resolved_tickets_with_uninvoiced_time.count} ticket${resolved_tickets_with_uninvoiced_time.count === 1 ? '' : 's'}`}
          empty={resolved_tickets_with_uninvoiced_time.count === 0}
          emptyText="No resolved tickets have un-invoiced time."
          color="text-orange-700"
        >
          <ul className="text-xs space-y-1 mt-2 max-h-40 overflow-y-auto">
            {resolved_tickets_with_uninvoiced_time.groups.slice(0, 5).map((g) => (
              <li key={g.ticket_id} className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1">
                <a className="hover:underline truncate flex-1" href={`/tickets/${g.ticket_id}`}>
                  <span className="font-mono text-slate-500">{g.ticket_uid}</span>
                  <span className="ml-1">{g.ticket_subject || 'untitled'}</span>
                </a>
                <span className="font-mono text-orange-700 whitespace-nowrap">{formatMoney(g.value_cents)}</span>
              </li>
            ))}
          </ul>
        </LeakageCard>

        <LeakageCard
          title="Stale draft invoices" icon={FileWarning}
          valueText={formatMoney(stale_draft_invoices.total_cents)}
          subText={`${stale_draft_invoices.count} invoice${stale_draft_invoices.count === 1 ? '' : 's'} older than ${data.params.stale_draft_days}d`}
          empty={stale_draft_invoices.count === 0}
          emptyText="No drafts have been sitting longer than the cutoff."
          color="text-yellow-700"
        >
          <ul className="text-xs space-y-1 mt-2 max-h-40 overflow-y-auto">
            {stale_draft_invoices.invoices.slice(0, 5).map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1">
                <a className="hover:underline truncate flex-1" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                  <span className="font-mono text-slate-500">{inv.invoice_uid}</span>
                  <span className="ml-1">{inv.customer_name}</span>
                  <span className="text-slate-400 ml-1">· {fmtDate(inv.created_at)}</span>
                </a>
                <span className="font-mono text-yellow-700 whitespace-nowrap">{formatMoney(inv.total_cents)}</span>
              </li>
            ))}
          </ul>
        </LeakageCard>

        <LeakageCard
          title="Overdue sent invoices" icon={AlertCircle}
          valueText={formatMoney(overdue_sent_invoices.total_cents)}
          subText={`${overdue_sent_invoices.count} invoice${overdue_sent_invoices.count === 1 ? '' : 's'} past due`}
          empty={overdue_sent_invoices.count === 0}
          emptyText="Nothing past due right now. ✓"
          color="text-red-700"
        >
          <ul className="text-xs space-y-1 mt-2 max-h-40 overflow-y-auto">
            {overdue_sent_invoices.invoices.slice(0, 5).map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1">
                <a className="hover:underline truncate flex-1" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                  <span className="font-mono text-slate-500">{inv.invoice_uid}</span>
                  <span className="ml-1">{inv.customer_name}</span>
                  <span className="text-red-500 ml-1">· {inv.days_overdue}d late</span>
                </a>
                <span className="font-mono text-red-700 whitespace-nowrap">{formatMoney(inv.total_cents)}</span>
              </li>
            ))}
          </ul>
        </LeakageCard>

        <LeakageCard
          title="Dormant customers" icon={UserMinus}
          valueText={`${dormant_customers.count} customer${dormant_customers.count === 1 ? '' : 's'}`}
          subText={`billable activity, no invoice in ${data.params.stale_invoice_days}+ days`}
          empty={dormant_customers.count === 0}
          emptyText="Every active customer is invoiced recently."
          color="text-slate-700"
        >
          <ul className="text-xs space-y-1 mt-2 max-h-40 overflow-y-auto">
            {dormant_customers.customers.slice(0, 5).map((c) => (
              <li key={c.customer_id} className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1">
                <a className="hover:underline truncate flex-1" href={`/customers/${c.customer_id}`}>
                  {c.customer_name}
                  <span className="text-slate-400 ml-1">
                    · {c.open_tickets} open · {c.uninvoiced_entries} unbilled
                  </span>
                </a>
                <span className="text-slate-500 whitespace-nowrap text-[10px]">{fmtDate(c.last_invoice_at) || 'never'}</span>
              </li>
            ))}
          </ul>
        </LeakageCard>
      </div>
    </section>
  );
}

function LeakageCard({ title, icon: Icon, valueText, subText, empty, emptyText, children, color }) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-white">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-slate-500 uppercase font-medium flex items-center gap-1">
          {Icon ? <Icon size={12} /> : null} {title}
        </div>
      </div>
      <div className={`text-xl font-semibold ${color}`}>{valueText}</div>
      <div className="text-xs text-slate-500">{subText}</div>
      {empty ? (
        <p className="text-xs text-emerald-600 mt-2">{emptyText}</p>
      ) : children}
    </div>
  );
}

function DashboardTab() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [d, s] = await Promise.all([
        fetchJson('/accounting/dashboard'),
        fetchJson('/accounting/status'),
      ]);
      setData(d);
      setStatus(s);
      setErr('');
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  if (err) return <div className="card text-red-600">{err}</div>;
  if (!data) return <div>Loading…</div>;

  return (
    <div>
      <LeakagePanel />

      {status && (
        <div className="card mb-4 bg-slate-50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">Module status</div>
              <div className="text-xs text-slate-600">{status.note}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(status.features).map(([k, v]) => (
                <span key={k} className={v ? 'badge-green' : 'badge-slate'}>
                  {v ? '✓' : '○'} {k.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <KPI label="Unpaid invoices" value={formatMoney(data.unpaid_invoices?.amount)} sub={`${data.unpaid_invoices?.n || 0} invoice(s)`} icon={FileText} color="text-yellow-700" />
        <KPI label="Overdue" value={formatMoney(data.overdue_invoices?.amount)} sub={`${data.overdue_invoices?.n || 0} invoice(s)`} icon={AlertCircle} color="text-red-600" />
        <KPI label="Income this month" value={formatMoney(data.income_this_month_cents)} sub="Sent + paid + overdue" icon={DollarSign} color="text-green-700" />
        <KPI label="Expenses this month" value={formatMoney(data.expenses_this_month_cents)} sub="Logged expenses" icon={Receipt} color="text-orange-700" />
        <KPI label="Net this month" value={formatMoney(data.net_this_month_cents)} sub="Income − expenses" icon={BarChart3} color={moneyColor(data.net_this_month_cents)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="card">
          <h3 className="font-semibold mb-2 flex items-center gap-1.5"><CreditCard size={14}/> Recent payments</h3>
          {data.recent_payments.length === 0 ? (
            <p className="text-sm text-slate-500">No payments recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th>When</th><th>Customer</th><th>Method</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody>
                {data.recent_payments.map((p, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1.5 text-xs">{fmtDateTime(p.received_at)}</td>
                    <td>{p.customer_name}</td>
                    <td><span className="badge-slate">{p.method}</span></td>
                    <td className="font-mono text-right">{formatMoney(p.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card">
          <h3 className="font-semibold mb-2 flex items-center gap-1.5"><Receipt size={14}/> Recent expenses</h3>
          {data.recent_expenses.length === 0 ? (
            <p className="text-sm text-slate-500">No expenses logged yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th>Date</th><th>Vendor</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody>
                {data.recent_expenses.map((e, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1.5 text-xs">{fmtDate(e.expense_date)}</td>
                    <td>{e.vendor}</td>
                    <td className="font-mono text-right">{formatMoney(e.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function KPI({ label, value, sub, icon: Icon, color }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-slate-500 uppercase">{label}</div>
        {Icon && <Icon size={14} className="text-slate-400" />}
      </div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}

// ============== Invoices ==============

function InvoicesTab() {
  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [err, setErr] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // { mode: 'create' | 'edit', invoice: { ... } }
  const [viewing, setViewing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [inv, cust, prod, tax] = await Promise.all([
        fetchJson('/invoices'),
        fetchJson('/customers'),
        fetchJson('/accounting/products?active=1'),
        fetchJson('/accounting/tax-rates?active=1'),
      ]);
      setInvoices(inv);
      setCustomers(cust);
      setProducts(prod);
      setTaxRates(tax);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => invoices.filter(i => {
    if (statusFilter !== 'all' && i.status !== statusFilter) return false;
    if (q) {
      const needle = q.toLowerCase();
      if (!`${i.invoice_uid} ${i.customer_name || ''}`.toLowerCase().includes(needle)) return false;
    }
    return true;
  }), [invoices, statusFilter, q]);

  const onMarkPaid = async (id) => {
    setBusy(true);
    try { await postJson(`/invoices/${id}/paid`, {}); await load(); }
    finally { setBusy(false); }
  };
  const onSend = async (id) => {
    setBusy(true);
    try { await postJson(`/invoices/${id}/send`, {}); await load(); }
    finally { setBusy(false); }
  };
  const onCheckout = async (id) => {
    setBusy(true);
    try {
      const r = await postJson(`/accounting/invoices/${id}/checkout`, {});
      if (r.url) window.open(r.url, '_blank');
    } catch (e) { alert('Stripe checkout failed: ' + (e?.response?.data?.error || e?.message)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className="input pl-8" placeholder="Search by number or customer…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <select className="input max-w-[180px]" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="viewed">Viewed</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button className="btn-primary" onClick={() => setEditing({ mode: 'create', invoice: blankInvoice() })}>
            <Plus size={14} /> New invoice
          </button>
        </div>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Subtotal</th>
              <th className="px-3 py-2 text-right">Tax</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan="8" className="px-3 py-6 text-center text-slate-500 text-sm">No invoices match your filter.</td></tr>
            )}
            {filtered.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{i.invoice_uid}</td>
                <td className="px-3 py-2">{i.customer_name}</td>
                <td className="px-3 py-2">{statusBadge(i.status)}</td>
                <td className="px-3 py-2 font-mono text-right">{formatMoney(i.subtotal_cents)}</td>
                <td className="px-3 py-2 font-mono text-right text-slate-600">{formatMoney(i.tax_cents)}</td>
                <td className="px-3 py-2 font-mono text-right font-semibold">{formatMoney(i.total_cents)}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(i.due_at)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button className="btn-ghost text-xs" onClick={() => setViewing(i)} title="View"><Eye size={12}/></button>
                  <a className="btn-ghost text-xs" href={`/api/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer" title="PDF"><Download size={12}/></a>
                  {i.status === 'draft' && <button className="btn-ghost text-xs" onClick={() => onSend(i.id)} disabled={busy} title="Send"><Send size={12}/></button>}
                  {i.status !== 'paid' && i.status !== 'draft' && i.status !== 'cancelled' && (
                    <>
                      <button className="btn-ghost text-xs" onClick={() => onCheckout(i.id)} disabled={busy} title="Stripe checkout">$</button>
                      <button className="btn-ghost text-xs" onClick={() => onMarkPaid(i.id)} disabled={busy} title="Mark paid"><CheckCircle2 size={12}/></button>
                    </>
                  )}
                  {i.status !== 'cancelled' && i.status !== 'paid' && (
                    <button className="btn-ghost text-xs text-red-600" onClick={async () => {
                      if (!window.confirm(`Cancel invoice ${i.invoice_uid}?`)) return;
                      try { await postJson(`/invoices/${i.id}/status`, { status: 'cancelled' }); await load(); }
                      catch (err) { alert('Cancel failed: ' + (err?.response?.data?.error || err.message)); }
                    }} disabled={busy} title="Cancel"><X size={12}/></button>
                  )}
                  <button className="btn-ghost text-xs" onClick={() => setEditing({ mode: 'edit', invoice: { ...i } })} title="Edit"><Edit3 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <InvoiceEditor
          mode={editing.mode}
          invoice={editing.invoice}
          customers={customers}
          products={products}
          taxRates={taxRates}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {viewing && (
        <InvoiceViewer
          invoice={viewing}
          taxRates={taxRates}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function InvoiceViewer({ invoice, taxRates, onClose }) {
  const [full, setFull] = useState(null);
  const [payments, setPayments] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [f, p] = await Promise.all([
          fetchJson(`/invoices/${invoice.id}`),
          fetchJson(`/accounting/payments?invoice_id=${invoice.id}`),
        ]);
        setFull(f);
        setPayments(p);
      } catch (e) { setErr(String(e)); }
    })();
  }, [invoice.id]);

  const taxRate = (id) => taxRates.find((r) => r.id === id);

  return (
    <Modal onClose={onClose} title={`Invoice ${invoice.invoice_uid}`}>
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {!full ? <div>Loading…</div> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-slate-500 uppercase mb-1">Status</div>
              <div>{statusBadge(full.status)}</div>
              <div className="text-xs text-slate-500 mt-2">Created: {fmtDateTime(full.created_at)}</div>
              {full.due_at && <div className="text-xs text-slate-500">Due: {fmtDate(full.due_at)}</div>}
              {full.sent_at && <div className="text-xs text-slate-500">Sent: {fmtDateTime(full.sent_at)}</div>}
              {full.paid_at && <div className="text-xs text-green-700">Paid: {fmtDateTime(full.paid_at)}</div>}
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500 uppercase mb-1">Totals</div>
              <div className="text-sm flex justify-between"><span>Subtotal</span><span className="font-mono">{formatMoney(full.subtotal_cents)}</span></div>
              <div className="text-sm flex justify-between"><span>Tax</span><span className="font-mono">{formatMoney(full.tax_cents)}</span></div>
              <div className="text-base flex justify-between font-semibold border-t border-slate-200 mt-1 pt-1"><span>Total</span><span className="font-mono">{formatMoney(full.total_cents)}</span></div>
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Line items</div>
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Description</th>
                    <th className="px-2 py-1.5 text-right">Qty</th>
                    <th className="px-2 py-1.5 text-right">Unit</th>
                    <th className="px-2 py-1.5 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {(full.line_items || []).map((li, idx) => {
                    const qty = Number(li.quantity ?? li.qty ?? 0);
                    const unit = Number(li.unit_price_cents ?? li.unit_price ?? 0);
                    const lineTotal = qty * unit;
                    const tr = li.taxable && li.tax_rate_id ? taxRate(li.tax_rate_id) : null;
                    return (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1.5">
                          <div>{li.description || '(no description)'}</div>
                          {tr && <div className="text-xs text-slate-500">tax: {tr.name} ({bpsToPercent(tr.rate_bps)}%)</div>}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-xs">{qty}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-xs">{formatMoney(unit)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{formatMoney(lineTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {full.notes && (
            <div>
              <div className="text-xs text-slate-500 uppercase mb-1">Notes</div>
              <p className="text-sm whitespace-pre-wrap bg-slate-50 rounded-md p-2">{full.notes}</p>
            </div>
          )}

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Payments</div>
            {payments.length === 0 ? (
              <p className="text-sm text-slate-500">No payments yet.</p>
            ) : (
              <div className="border border-slate-200 rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5 text-left">When</th>
                      <th className="px-2 py-1.5 text-left">Method</th>
                      <th className="px-2 py-1.5 text-left">Status</th>
                      <th className="px-2 py-1.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id} className="border-t">
                        <td className="px-2 py-1.5 text-xs">{fmtDateTime(p.received_at)}</td>
                        <td className="px-2 py-1.5"><span className="badge-slate">{p.method}</span></td>
                        <td className="px-2 py-1.5">{statusBadge(p.status)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{formatMoney(p.amount_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
            <a className="btn-secondary" href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer">
              <Download size={14}/> Open PDF
            </a>
            <button className="btn-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function blankInvoice() {
  return {
    customer_id: '',
    invoice_uid: '',
    status: 'draft',
    issue_date: todayIso(),
    due_date: '',
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    notes: '',
    line_items: [],
  };
}

function InvoiceEditor({ mode, invoice, customers, products, taxRates, onClose, onSaved }) {
  const [form, setForm] = useState(invoice);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Live preview totals, recomputed by the server. This guarantees the
  // Subtotal / Tax / Total shown to the operator matches the saved
  // invoice byte-for-byte — no client/server drift when the global tax
  // model applies to lines with no own tax_rate_id. See postSave bug
  // "invoice line price not showing in total when adding an hour service"
  // (2026-06-30, T-79EB14) — the editor used to compute tax itself and
  // forgot the global tax model, so $100 line + 5%+7% BC tax showed as
  // $100 total instead of $112.
  const [previewTotals, setPreviewTotals] = useState({ subtotal_cents: 0, tax_lines: [], tax_cents: 0, total_cents: 0, tax_model_label: '' });

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addLine = () => {
    set('line_items', [...(form.line_items || []), { description: '', quantity: 1, unit_price_cents: 0, tax_rate_id: null, taxable: true }]);
  };
  const setLine = (idx, k, v) => {
    const items = [...(form.line_items || [])];
    items[idx] = { ...items[idx], [k]: v };
    set('line_items', items);
  };
  const removeLine = (idx) => {
    const items = [...(form.line_items || [])];
    items.splice(idx, 1);
    set('line_items', items);
  };
  const pickProduct = (idx, productId) => {
    const p = products.find((x) => String(x.id) === String(productId));
    if (!p) return;
    const items = [...(form.line_items || [])];
    items[idx] = {
      ...items[idx],
      description: p.name,
      unit_price_cents: p.unit_price_cents,
      taxable: !!p.taxable,
      tax_rate_id: p.default_tax_rate_id || null,
      product_id: p.id,
    };
    set('line_items', items);
  };

  // Live server-computed preview totals. Debounced 200ms so each keystroke
  // doesn't fire a request. The server applies the configured default tax
  // model (`gst_pst_bc` in BC: 5% GST + 7% PST) for any line that is
  // taxable but has no own tax_rate_id — which is the case the previous
  // bug fix targets (product picked from catalog without a default rate,
  // or a manually-typed service line).
  useEffect(() => {
    const items = form.line_items || [];
    if (!items.length) {
      setPreviewTotals({ subtotal_cents: 0, tax_lines: [], tax_cents: 0, total_cents: 0, tax_model_label: '' });
      return;
    }
    const t = setTimeout(async () => {
      try {
        const payload = {
          line_items: items.map((li) => ({
            description: li.description || '',
            quantity: Number(li.quantity) || 0,
            unit_price_cents: Number(li.unit_price_cents) || 0,
            taxable: !!li.taxable,
            tax_rate_id: li.taxable && li.tax_rate_id ? Number(li.tax_rate_id) : null,
          })),
        };
        const totals = await postJson('/invoices/preview', payload);
        setPreviewTotals(totals);
      } catch (e) {
        // Preview is non-critical — keep the last good totals rather than
        // clearing the panel if a request fails.
      }
    }, 200);
    return () => clearTimeout(t);
  }, [form.line_items]);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const payload = {
        customer_id: Number(form.customer_id),
        invoice_uid: form.invoice_uid || undefined,
        status: form.status || 'draft',
        issue_date: form.issue_date || todayIso(),
        due_date: form.due_date || null,
        notes: form.notes || null,
        line_items: (form.line_items || []).map((li) => ({
          description: li.description,
          quantity: Number(li.quantity) || 0,
          unit_price_cents: Number(li.unit_price_cents) || 0,
          taxable: !!li.taxable,
          tax_rate_id: li.taxable && li.tax_rate_id ? Number(li.tax_rate_id) : null,
        })),
      };
      if (mode === 'create') await postJson('/invoices', payload);
      else await putJson(`/invoices/${form.id}`, payload);
      await onSaved();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={mode === 'create' ? 'New invoice' : `Edit ${form.invoice_uid}`}>
      <div className="space-y-3">
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Customer</label>
            <select className="input" value={form.customer_id || ''} onChange={(e) => set('customer_id', e.target.value)}>
              <option value="">— select —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status || 'draft'} onChange={(e) => set('status', e.target.value)}>
              <option>draft</option><option>sent</option><option>viewed</option>
              <option>paid</option><option>overdue</option><option>cancelled</option>
            </select>
          </div>
          <div>
            <label className="label">Issue date</label>
            <input className="input" type="date" value={form.issue_date || ''} onChange={(e) => set('issue_date', e.target.value)} />
          </div>
          <div>
            <label className="label">Due date</label>
            <input className="input" type="date" value={form.due_date || ''} onChange={(e) => set('due_date', e.target.value)} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="label !mb-0">Line items</label>
            <button className="btn-secondary text-xs" onClick={addLine}><Plus size={12}/> Add line</button>
          </div>
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="px-2 py-1.5 text-left">Description</th>
                  <th className="px-2 py-1.5 w-20 text-right">Qty</th>
                  <th className="px-2 py-1.5 w-28 text-right">Unit price</th>
                  <th className="px-2 py-1.5 w-12 text-center">Tax?</th>
                  <th className="px-2 py-1.5 w-28">Tax rate</th>
                  <th className="px-2 py-1.5 w-28 text-right">Line total</th>
                  <th className="px-2 py-1.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {(!form.line_items || form.line_items.length === 0) && (
                  <tr><td colSpan="7" className="px-2 py-3 text-center text-slate-500 text-xs">No lines yet — click "Add line" to start.</td></tr>
                )}
                {(form.line_items || []).map((li, idx) => {
                  const lineTotal = (Number(li.quantity) || 0) * (Number(li.unit_price_cents) || 0);
                  return (
                    <tr key={idx} className="border-t">
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1">
                          <select className="input !w-32 !text-xs" onChange={(e) => e.target.value && pickProduct(idx, e.target.value)} value="">
                            <option value="">From catalog…</option>
                            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <input className="input !text-xs" value={li.description || ''} onChange={(e) => setLine(idx, 'description', e.target.value)} placeholder="Item description" />
                        </div>
                      </td>
                      <td className="px-2 py-1.5"><input className="input !text-xs text-right" type="number" step="0.01" value={li.quantity ?? 1} onChange={(e) => setLine(idx, 'quantity', e.target.value)} /></td>
                      <td className="px-2 py-1.5"><input className="input !text-xs text-right" type="number" step="0.01" value={centsToDollars(li.unit_price_cents)} onChange={(e) => setLine(idx, 'unit_price_cents', dollarsToCents(e.target.value))} /></td>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={!!li.taxable} onChange={(e) => setLine(idx, 'taxable', e.target.checked)} />
                      </td>
                      <td className="px-2 py-1.5">
                        <select className="input !text-xs" value={li.tax_rate_id || ''} onChange={(e) => setLine(idx, 'tax_rate_id', e.target.value ? Number(e.target.value) : null)} disabled={!li.taxable}>
                          <option value="">— none —</option>
                          {taxRates.map((r) => <option key={r.id} value={r.id}>{r.name} ({bpsToPercent(r.rate_bps)}%)</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-xs">{formatMoney(lineTotal)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <button className="btn-ghost text-xs" onClick={() => removeLine(idx)}><Trash2 size={12}/></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Notes</label>
            <textarea className="input" rows="3" value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Notes visible on invoice" />
          </div>
          <div className="bg-slate-50 rounded-md p-3 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{formatMoney(previewTotals.subtotal_cents)}</span></div>
            <div className="flex justify-between"><span>Tax{previewTotals.tax_model_label ? <span className="text-xs text-slate-500 ml-1">({previewTotals.tax_model_label})</span> : null}</span><span className="font-mono">{formatMoney(previewTotals.tax_cents)}</span></div>
            <div className="flex justify-between font-semibold border-t border-slate-200 mt-1.5 pt-1.5"><span>Total</span><span className="font-mono">{formatMoney(previewTotals.total_cents)}</span></div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !form.customer_id}>
            <Save size={14}/> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============== Customers ==============

function CustomersTab() {
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [detailFor, setDetailFor] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [c, i, p] = await Promise.all([
        fetchJson('/customers'),
        fetchJson('/invoices'),
        fetchJson('/accounting/payments'),
      ]);
      setCustomers(c); setInvoices(i); setPayments(p);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!q) return customers;
    const needle = q.toLowerCase();
    return customers.filter((c) => `${c.name} ${c.email || ''}`.toLowerCase().includes(needle));
  }, [customers, q]);

  const balances = useMemo(() => {
    const m = {};
    invoices.forEach((inv) => {
      if (!['sent', 'overdue', 'viewed', 'draft'].includes(inv.status)) return;
      m[inv.customer_id] = (m[inv.customer_id] || 0) + (inv.total_cents || 0);
    });
    return m;
  }, [invoices]);

  const paidByCustomer = useMemo(() => {
    // payments table doesn't carry customer_id directly, but invoice does.
    const m = {};
    invoices.forEach((inv) => { m[inv.id] = inv.customer_id; });
    const totals = {};
    payments.forEach((p) => {
      if (p.status !== 'succeeded') return;
      const cid = m[p.invoice_id];
      if (cid) totals[cid] = (totals[cid] || 0) + (p.amount_cents || 0);
    });
    return totals;
  }, [invoices, payments]);

  return (
    <div>
      <div className="card mb-3">
        <div className="flex gap-2 items-center">
          <div className="flex-1">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className="input pl-8" placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <button className="btn-primary" onClick={() => setEditing({})}>
            <Plus size={14}/> New customer
          </button>
        </div>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2 text-right">Balance</th>
              <th className="px-3 py-2 text-right">Paid (total)</th>
              <th className="px-3 py-2 text-right">Invoices</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan="7" className="px-3 py-6 text-center text-slate-500 text-sm">No customers yet.</td></tr>
            )}
            {filtered.map((c) => {
              const invCount = invoices.filter((i) => i.customer_id === c.id).length;
              return (
                <tr key={c.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium">
                    <button className="text-brand-700 hover:underline" onClick={() => setDetailFor(c)}>
                      {c.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{c.email || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{c.phone || '—'}</td>
                  <td className={`px-3 py-2 font-mono text-right ${moneyColor(balances[c.id] || 0)}`}>{formatMoney(balances[c.id] || 0)}</td>
                  <td className="px-3 py-2 font-mono text-right text-green-700">{formatMoney(paidByCustomer[c.id] || 0)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{invCount}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button className="btn-ghost text-xs" onClick={() => setDetailFor(c)} title="Open detail"><Eye size={12}/></button>
                    <a href={`/customers/${c.id}`} className="btn-ghost text-xs" target="_blank" rel="noreferrer" title="Open in HQ"><ChevronRight size={12}/></a>
                    <button className="btn-ghost text-xs" onClick={() => setEditing({ ...c })} title="Edit"><Edit3 size={12}/></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <CustomerEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {detailFor && (
        <CustomerDetailPanel
          customer={detailFor}
          invoices={invoices}
          payments={payments}
          onClose={() => setDetailFor(null)}
          onEdit={() => { setEditing({ ...detailFor }); setDetailFor(null); }}
        />
      )}
    </div>
  );
}

function CustomerDetailPanel({ customer, invoices, payments, onClose, onEdit }) {
  const myInvoices = useMemo(
    () => invoices.filter((i) => i.customer_id === customer.id)
                  .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [invoices, customer.id]
  );
  const myPayments = useMemo(() => {
    const invoiceIds = new Set(myInvoices.map((i) => i.id));
    return payments.filter((p) => invoiceIds.has(p.invoice_id))
                   .sort((a, b) => (b.received_at || '').localeCompare(a.received_at || ''));
  }, [payments, myInvoices]);

  const stats = useMemo(() => {
    const inv = { count: 0, total: 0, outstanding: 0, paid: 0 };
    myInvoices.forEach((i) => {
      inv.count += 1;
      inv.total += i.total_cents || 0;
      if (['sent', 'overdue', 'viewed', 'draft'].includes(i.status)) inv.outstanding += i.total_cents || 0;
      if (i.status === 'paid') inv.paid += i.total_cents || 0;
    });
    const paid = myPayments.filter((p) => p.status === 'succeeded')
                           .reduce((s, p) => s + (p.amount_cents || 0), 0);
    return { ...inv, payments_total: paid };
  }, [myInvoices, myPayments]);

  return (
    <Modal onClose={onClose} title={`${customer.name} — accounting detail`}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Contact</div>
            <div className="space-y-0.5">
              <div>{customer.email || <span className="text-slate-400">no email</span>}</div>
              <div>{customer.phone || <span className="text-slate-400">no phone</span>}</div>
              {customer.business_name && <div className="text-slate-600">{customer.business_name}</div>}
              {customer.billing_address && <div className="text-xs text-slate-600">{customer.billing_address}</div>}
              {customer.tax_number && <div className="text-xs text-slate-500">Tax #: {customer.tax_number}</div>}
              {customer.notes && <div className="text-xs text-slate-500 italic mt-1">{customer.notes}</div>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Invoiced (total)" value={formatMoney(stats.total)} sub={`${stats.count} invoice(s)`} color="text-slate-700" />
            <Tile label="Outstanding" value={formatMoney(stats.outstanding)} color={stats.outstanding > 0 ? 'text-yellow-700' : 'text-slate-500'} />
            <Tile label="Invoiced as paid" value={formatMoney(stats.paid)} color="text-green-700" />
            <Tile label="Payments received" value={formatMoney(stats.payments_total)} color="text-green-700" />
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500 uppercase mb-1">Invoices</div>
          {myInvoices.length === 0 ? (
            <p className="text-sm text-slate-500">No invoices yet.</p>
          ) : (
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left">#</th>
                    <th className="px-2 py-1.5 text-left">Status</th>
                    <th className="px-2 py-1.5 text-left">Issued</th>
                    <th className="px-2 py-1.5 text-right">Total</th>
                    <th className="px-2 py-1.5 text-right">Paid</th>
                    <th className="px-2 py-1.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {myInvoices.map((i) => {
                    const invPaid = myPayments.filter((p) => p.invoice_id === i.id && p.status === 'succeeded')
                                              .reduce((s, p) => s + (p.amount_cents || 0), 0);
                    const bal = (i.total_cents || 0) - invPaid;
                    return (
                      <tr key={i.id} className="border-t">
                        <td className="px-2 py-1.5 font-mono text-xs">{i.invoice_uid}</td>
                        <td className="px-2 py-1.5">{statusBadge(i.status)}</td>
                        <td className="px-2 py-1.5 text-xs text-slate-600">{fmtDate(i.created_at)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{formatMoney(i.total_cents)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-green-700">{formatMoney(invPaid)}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${moneyColor(bal)}`}>{formatMoney(bal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-slate-500 uppercase mb-1">Payment history</div>
          {myPayments.length === 0 ? (
            <p className="text-sm text-slate-500">No payments recorded.</p>
          ) : (
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left">When</th>
                    <th className="px-2 py-1.5 text-left">Invoice</th>
                    <th className="px-2 py-1.5 text-left">Method</th>
                    <th className="px-2 py-1.5 text-left">Status</th>
                    <th className="px-2 py-1.5 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {myPayments.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="px-2 py-1.5 text-xs">{fmtDateTime(p.received_at)}</td>
                      <td className="px-2 py-1.5 font-mono text-xs">{p.invoice_uid}</td>
                      <td className="px-2 py-1.5"><span className="badge-slate">{p.method}</span></td>
                      <td className="px-2 py-1.5">{statusBadge(p.status)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{formatMoney(p.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={onEdit}><Edit3 size={14}/> Edit customer</button>
        </div>
      </div>
    </Modal>
  );
}

function Tile({ label, value, sub, color }) {
  return (
    <div className="border border-slate-200 rounded-md p-2">
      <div className="text-xs text-slate-500 uppercase">{label}</div>
      <div className={`text-lg font-semibold ${color || 'text-slate-700'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function CustomerEditor({ initial, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    name: initial.name || '',
    email: initial.email || '',
    phone: initial.phone || '',
    business_name: initial.business_name || '',
    billing_address: initial.billing_address || '',
    shipping_address: initial.shipping_address || '',
    tax_number: initial.tax_number || '',
    notes: initial.notes || '',
    status: initial.status || 'active',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (isNew) await postJson('/customers', form);
      else await putJson(`/customers/${initial.id}`, form);
      await onSaved();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={isNew ? 'New customer' : `Edit ${initial.name}`}>
      <div className="space-y-2">
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className="label">Business name</label><input className="input" value={form.business_name} onChange={(e) => set('business_name', e.target.value)} /></div>
          <div><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div><label className="label">Phone</label><input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div className="col-span-2"><label className="label">Billing address</label><input className="input" value={form.billing_address} onChange={(e) => set('billing_address', e.target.value)} /></div>
          <div className="col-span-2"><label className="label">Shipping / service address</label><input className="input" value={form.shipping_address} onChange={(e) => set('shipping_address', e.target.value)} /></div>
          <div><label className="label">Tax number</label><input className="input" value={form.tax_number} onChange={(e) => set('tax_number', e.target.value)} /></div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !form.name}>
            <Save size={14}/> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============== Products & Services ==============

function ProductsTab() {
  const [items, setItems] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [p, t] = await Promise.all([fetchJson('/accounting/products'), fetchJson('/accounting/tax-rates')]);
      setItems(p); setTaxRates(t);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (!showInactive && !i.active) return false;
      if (q && !`${i.name} ${i.sku || ''}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [items, q, showInactive]);

  const toggleActive = async (item) => {
    setBusy(true);
    try {
      await putJson(`/accounting/products/${item.id}`, { active: !item.active });
      await load();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card mb-3 flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input className="input pl-8" placeholder="Search by name or SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <button className="btn-primary" onClick={() => setEditing({})}>
          <Plus size={14}/> New product / service
        </button>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Unit price</th>
              <th className="px-3 py-2">Default tax</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan="6" className="px-3 py-6 text-center text-slate-500 text-sm">No products or services yet.</td></tr>
            )}
            {filtered.map((i) => (
              <tr key={i.id} className={`border-t ${!i.active ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs">{i.sku || '—'}</td>
                <td className="px-3 py-2">
                  <div className="font-medium">{i.name}</div>
                  {i.description && <div className="text-xs text-slate-500 line-clamp-1">{i.description}</div>}
                </td>
                <td className="px-3 py-2 font-mono text-right">{formatMoney(i.unit_price_cents)}</td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {i.taxable ? (i.default_tax_name ? `${i.default_tax_name} (${bpsToPercent(i.default_tax_rate_bps)}%)` : 'Taxable') : 'Non-taxable'}
                </td>
                <td className="px-3 py-2">
                  {i.active ? <span className="badge-green">active</span> : <span className="badge-slate">inactive</span>}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button className="btn-ghost text-xs" onClick={() => toggleActive(i)} disabled={busy} title={i.active ? 'Deactivate' : 'Activate'}>
                    {i.active ? <EyeOff size={12}/> : <Eye size={12}/>}
                  </button>
                  <button className="btn-ghost text-xs" onClick={() => setEditing({ ...i })} title="Edit"><Edit3 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <ProductEditor
          initial={editing}
          taxRates={taxRates}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function ProductEditor({ initial, taxRates, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    sku: initial.sku || '',
    name: initial.name || '',
    description: initial.description || '',
    unit_price_dollars: centsToDollars(initial.unit_price_cents),
    taxable: initial.taxable ?? true,
    default_tax_rate_id: initial.default_tax_rate_id || '',
    active: initial.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const payload = {
        sku: form.sku || null,
        name: form.name,
        description: form.description || null,
        unit_price_cents: dollarsToCents(form.unit_price_dollars),
        taxable: !!form.taxable,
        default_tax_rate_id: form.taxable && form.default_tax_rate_id ? Number(form.default_tax_rate_id) : null,
        active: !!form.active,
      };
      if (isNew) await postJson('/accounting/products', payload);
      else await putJson(`/accounting/products/${initial.id}`, payload);
      await onSaved();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={isNew ? 'New product / service' : `Edit ${initial.name}`}>
      <div className="space-y-2">
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">SKU / code</label><input className="input" value={form.sku} onChange={(e) => set('sku', e.target.value)} placeholder="optional" /></div>
          <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="col-span-2"><label className="label">Description</label><textarea className="input" rows="2" value={form.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div><label className="label">Unit price (CAD)</label><input className="input" type="number" step="0.01" value={form.unit_price_dollars} onChange={(e) => set('unit_price_dollars', e.target.value)} /></div>
          <div>
            <label className="label">Default tax rate</label>
            <select className="input" value={form.default_tax_rate_id || ''} onChange={(e) => set('default_tax_rate_id', e.target.value)} disabled={!form.taxable}>
              <option value="">— none —</option>
              {taxRates.map((r) => <option key={r.id} value={r.id}>{r.name} ({bpsToPercent(r.rate_bps)}%)</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.taxable} onChange={(e) => set('taxable', e.target.checked)} /> Taxable by default</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active</label>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !form.name}>
            <Save size={14}/> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============== Tax Rates ==============

function TaxRatesTab() {
  const [rates, setRates] = useState([]);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try { setRates(await fetchJson('/accounting/tax-rates')); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="card mb-3 flex items-center justify-between">
        <p className="text-xs text-slate-600">Tax rates are stored as basis points (5% = 500). They apply to invoice line items and can be overridden per-invoice or per-product.</p>
        <button className="btn-primary" onClick={() => setEditing({ name: '', rate_pct: '5', jurisdiction: '', is_compound: false, active: true })}>
          <Plus size={14}/> New tax rate
        </button>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2">Jurisdiction</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rates.length === 0 && (
              <tr><td colSpan="6" className="px-3 py-6 text-center text-slate-500 text-sm">No tax rates yet. Common ones to add: GST 5%, PST 7%, HST 13%.</td></tr>
            )}
            {rates.map((r) => (
              <tr key={r.id} className={`border-t ${!r.active ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2 font-mono text-right">{bpsToPercent(r.rate_bps)}%</td>
                <td className="px-3 py-2 text-xs text-slate-600">{r.jurisdiction || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.is_compound ? 'compound' : 'standard'}</td>
                <td className="px-3 py-2">{r.active ? <span className="badge-green">active</span> : <span className="badge-slate">inactive</span>}</td>
                <td className="px-3 py-2 text-right">
                  <button className="btn-ghost text-xs" onClick={() => setEditing({
                    id: r.id, name: r.name, rate_pct: bpsToPercent(r.rate_bps),
                    jurisdiction: r.jurisdiction || '', is_compound: !!r.is_compound, active: !!r.active,
                  })}><Edit3 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <TaxRateEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function TaxRateEditor({ initial, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const payload = {
        name: form.name,
        rate_bps: percentToBps(form.rate_pct),
        jurisdiction: form.jurisdiction || null,
        is_compound: !!form.is_compound,
        active: !!form.active,
      };
      if (isNew) await postJson('/accounting/tax-rates', payload);
      else await putJson(`/accounting/tax-rates/${initial.id}`, payload);
      await onSaved();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={isNew ? 'New tax rate' : `Edit ${initial.name}`}>
      <div className="space-y-2">
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. GST" /></div>
          <div><label className="label">Rate (%)</label><input className="input" type="number" step="0.001" value={form.rate_pct} onChange={(e) => set('rate_pct', e.target.value)} /></div>
          <div><label className="label">Jurisdiction</label><input className="input" value={form.jurisdiction} onChange={(e) => set('jurisdiction', e.target.value)} placeholder="e.g. CA-BC (optional)" /></div>
          <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={!!form.is_compound} onChange={(e) => set('is_compound', e.target.checked)} /> Compound tax</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.active} onChange={(e) => set('active', e.target.checked)} /> Active</label>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !form.name}>
            <Save size={14}/> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============== Expenses ==============

function ExpensesTab() {
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const [e, c, t] = await Promise.all([
        fetchJson('/accounting/expenses?' + qs.toString()),
        fetchJson('/accounting/expense-categories'),
        fetchJson('/accounting/tax-rates'),
      ]);
      setExpenses(e); setCategories(c); setTaxRates(t);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const total = useMemo(() => expenses.reduce((s, e) => s + (e.amount_cents || 0), 0), [expenses]);
  const totalTax = useMemo(() => expenses.reduce((s, e) => s + (e.tax_cents || 0), 0), [expenses]);

  return (
    <div>
      <div className="card mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn-secondary" onClick={load}>Apply</button>
        <button className="btn-ghost text-xs" onClick={() => { setFrom(''); setTo(''); setTimeout(load, 0); }}>Clear</button>
        <div className="flex-1" />
        <button className="btn-primary" onClick={() => setEditing({ expense_date: todayIso(), payment_method: 'card', business_use: true, amount_dollars: '0.00', tax_dollars: '0.00' })}>
          <Plus size={14}/> New expense
        </button>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="card"><div className="text-xs text-slate-500 uppercase">Count</div><div className="text-2xl font-semibold">{expenses.length}</div></div>
        <div className="card"><div className="text-xs text-slate-500 uppercase">Total (incl. tax)</div><div className="text-2xl font-semibold text-orange-700">{formatMoney(total)}</div></div>
        <div className="card"><div className="text-xs text-slate-500 uppercase">Tax portion</div><div className="text-2xl font-semibold text-slate-700">{formatMoney(totalTax)}</div></div>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Tax</th>
              <th className="px-3 py-2">Receipt</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 && (
              <tr><td colSpan="8" className="px-3 py-6 text-center text-slate-500 text-sm">No expenses in this range.</td></tr>
            )}
            {expenses.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="px-3 py-2 text-xs">{fmtDate(e.expense_date)}</td>
                <td className="px-3 py-2 font-medium">{e.vendor}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{e.category_name || '—'}</td>
                <td className="px-3 py-2"><span className="badge-slate">{e.payment_method}</span></td>
                <td className="px-3 py-2 font-mono text-right">{formatMoney(e.amount_cents)}</td>
                <td className="px-3 py-2 font-mono text-right text-slate-600">{formatMoney(e.tax_cents)}</td>
                <td className="px-3 py-2 text-xs">
                  {e.receipt_path ? <a className="text-brand-600 hover:underline" href={`/api/accounting/expenses/${e.id}/receipt`} target="_blank" rel="noreferrer">view</a> : '—'}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button className="btn-ghost text-xs" onClick={() => setEditing({ ...e, amount_dollars: centsToDollars(e.amount_cents), tax_dollars: centsToDollars(e.tax_cents) })} title="Edit"><Edit3 size={12}/></button>
                  <button className="btn-ghost text-xs text-red-600" onClick={async () => {
                    if (!window.confirm(`Delete expense from ${e.vendor} (${formatMoney(e.amount_cents)})? This cannot be undone.`)) return;
                    try { await delJson(`/accounting/expenses/${e.id}`); await load(); }
                    catch (err) { alert('Delete failed: ' + (err?.response?.data?.error || err.message)); }
                  }} title="Delete"><Trash2 size={12}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <ExpenseEditor
          initial={editing}
          categories={categories}
          taxRates={taxRates}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function ExpenseEditor({ initial, categories, taxRates, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    vendor: initial.vendor || '',
    expense_date: initial.expense_date || todayIso(),
    category_id: initial.category_id || '',
    amount_dollars: initial.amount_dollars || '0.00',
    tax_dollars: initial.tax_dollars || '0.00',
    tax_rate_id: initial.tax_rate_id || '',
    payment_method: initial.payment_method || 'other',
    business_use: initial.business_use ?? true,
    notes: initial.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const payload = {
        vendor: form.vendor,
        expense_date: form.expense_date,
        category_id: form.category_id ? Number(form.category_id) : null,
        amount_cents: dollarsToCents(form.amount_dollars),
        tax_cents: dollarsToCents(form.tax_dollars),
        tax_rate_id: form.tax_rate_id ? Number(form.tax_rate_id) : null,
        payment_method: form.payment_method,
        business_use: !!form.business_use,
        notes: form.notes || null,
      };
      if (isNew) await postJson('/accounting/expenses', payload);
      else await putJson(`/accounting/expenses/${initial.id}`, payload);
      await onSaved();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  const uploadReceipt = async (file) => {
    if (!file || isNew) {
      alert('Save the expense first, then attach a receipt.');
      return;
    }
    setUploading(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/accounting/expenses/${initial.id}/receipt`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await onSaved();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setUploading(false); }
  };

  const deleteReceipt = async () => {
    if (isNew) return;
    setBusy(true);
    try { await delJson(`/accounting/expenses/${initial.id}/receipt`); await onSaved(); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={isNew ? 'New expense' : `Edit expense #${initial.id}`}>
      <div className="space-y-2">
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">Vendor</label><input className="input" value={form.vendor} onChange={(e) => set('vendor', e.target.value)} /></div>
          <div><label className="label">Date</label><input className="input" type="date" value={form.expense_date} onChange={(e) => set('expense_date', e.target.value)} /></div>
          <div>
            <label className="label">Category</label>
            <select className="input" value={form.category_id || ''} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">— uncategorized —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Payment method</label>
            <select className="input" value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
              <option value="cash">Cash</option>
              <option value="cheque">Cheque</option>
              <option value="e_transfer">E-transfer</option>
              <option value="card">Card</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div><label className="label">Amount (CAD, incl. tax)</label><input className="input" type="number" step="0.01" value={form.amount_dollars} onChange={(e) => set('amount_dollars', e.target.value)} /></div>
          <div><label className="label">Tax portion (CAD)</label><input className="input" type="number" step="0.01" value={form.tax_dollars} onChange={(e) => set('tax_dollars', e.target.value)} /></div>
          <div className="col-span-2">
            <label className="label">Tax rate (informational)</label>
            <select className="input" value={form.tax_rate_id || ''} onChange={(e) => set('tax_rate_id', e.target.value)}>
              <option value="">— none —</option>
              {taxRates.map((r) => <option key={r.id} value={r.id}>{r.name} ({bpsToPercent(r.rate_bps)}%)</option>)}
            </select>
          </div>
          <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.business_use} onChange={(e) => set('business_use', e.target.checked)} /> Business-related</label>
        </div>

        {!isNew && (
          <div className="border-t border-slate-200 pt-2 space-y-2">
            <label className="label">Receipt</label>
            {initial.receipt_path && (
              <div className="text-sm flex items-center gap-2">
                <a className="text-brand-600 hover:underline" href={`/api/accounting/expenses/${initial.id}/receipt`} target="_blank" rel="noreferrer">view current</a>
                <button className="btn-ghost text-xs text-red-600" onClick={deleteReceipt} disabled={busy}>remove</button>
                <span className="text-xs text-slate-500">· upload a new one below to replace it</span>
              </div>
            )}
            <ReceiptCapture onCapture={uploadReceipt} disabled={busy || uploading} />
            {uploading && <div className="text-xs text-slate-500">Uploading…</div>}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !form.vendor || !form.expense_date}>
            <Save size={14}/> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============== Categories ==============

function CategoriesTab() {
  const [categories, setCategories] = useState([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setCategories(await fetchJson('/accounting/expense-categories')); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr('');
    try {
      await postJson('/accounting/expense-categories', { name: name.trim() });
      setName('');
      await load();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card mb-3">
        <p className="text-xs text-slate-600 mb-2">Categories are used to group expenses for reporting. Add things like "Office supplies", "Software subscriptions", "Travel", "Meals".</p>
        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="New category name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="btn-primary" onClick={add} disabled={busy || !name.trim()}><Plus size={14}/> Add</button>
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Default tax</th>
            </tr>
          </thead>
          <tbody>
            {categories.length === 0 && (
              <tr><td colSpan="2" className="px-3 py-6 text-center text-slate-500 text-sm">No categories yet.</td></tr>
            )}
            {categories.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{c.tax_name ? `${c.tax_name} (${bpsToPercent(c.tax_rate_bps)}%)` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============== Payments ==============

function PaymentsTab() {
  const [payments, setPayments] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [methodFilter, setMethodFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [p, i] = await Promise.all([fetchJson('/accounting/payments'), fetchJson('/invoices')]);
      setPayments(p); setInvoices(i);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (methodFilter === 'all') return payments;
    return payments.filter((p) => p.method === methodFilter);
  }, [payments, methodFilter]);

  return (
    <div>
      <div className="card mb-3 flex flex-wrap items-center gap-2">
        <select className="input max-w-[200px]" value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
          <option value="all">All methods</option>
          <option value="stripe">Stripe</option>
          <option value="cash">Cash</option>
          <option value="cheque">Cheque</option>
          <option value="e_transfer">E-transfer</option>
          <option value="other">Other</option>
        </select>
        <div className="flex-1" />
        <button className="btn-primary" onClick={() => setEditing({ method: 'other', status: 'succeeded', received_at: new Date().toISOString().slice(0, 16) })}>
          <Plus size={14}/> Record payment
        </button>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Invoice</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan="7" className="px-3 py-6 text-center text-slate-500 text-sm">No payments yet.</td></tr>
            )}
            {filtered.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-2 text-xs">{fmtDateTime(p.received_at)}</td>
                <td className="px-3 py-2 font-mono text-xs">{p.invoice_uid}</td>
                <td className="px-3 py-2">{p.customer_name}</td>
                <td className="px-3 py-2"><span className="badge-slate">{p.method}</span></td>
                <td className="px-3 py-2">{statusBadge(p.status)}</td>
                <td className="px-3 py-2 font-mono text-right">{formatMoney(p.amount_cents)}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{p.notes || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <PaymentEditor
          initial={editing}
          invoices={invoices}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function PaymentEditor({ initial, invoices, onClose, onSaved }) {
  const [form, setForm] = useState({
    invoice_id: initial.invoice_id || '',
    amount_dollars: initial.amount_dollars || '',
    method: initial.method || 'other',
    status: initial.status || 'succeeded',
    received_at: initial.received_at || new Date().toISOString().slice(0, 16),
    notes: initial.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const payload = {
        invoice_id: Number(form.invoice_id),
        amount_cents: dollarsToCents(form.amount_dollars),
        method: form.method,
        status: form.status,
        received_at: form.received_at ? new Date(form.received_at).toISOString() : undefined,
        notes: form.notes || null,
      };
      await postJson('/accounting/payments', payload);
      await onSaved();
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title="Record payment">
      <div className="space-y-2">
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className="label">Invoice</label>
            <select className="input" value={form.invoice_id || ''} onChange={(e) => set('invoice_id', e.target.value)}>
              <option value="">— select —</option>
              {invoices.map((i) => <option key={i.id} value={i.id}>{i.invoice_uid} — {i.customer_name} ({formatMoney(i.total_cents)})</option>)}
            </select>
          </div>
          <div><label className="label">Amount (CAD)</label><input className="input" type="number" step="0.01" value={form.amount_dollars} onChange={(e) => set('amount_dollars', e.target.value)} /></div>
          <div>
            <label className="label">Method</label>
            <select className="input" value={form.method} onChange={(e) => set('method', e.target.value)}>
              <option value="cash">Cash</option>
              <option value="cheque">Cheque</option>
              <option value="e_transfer">E-transfer</option>
              <option value="card">Card</option>
              <option value="stripe">Stripe</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="succeeded">Succeeded</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
              <option value="refunded">Refunded</option>
            </select>
          </div>
          <div><label className="label">Received at</label><input className="input" type="datetime-local" value={form.received_at} onChange={(e) => set('received_at', e.target.value)} /></div>
          <div className="col-span-2"><label className="label">Notes</label><input className="input" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !form.invoice_id || !form.amount_dollars}>
            <Save size={14}/> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============== Tax Summary (Phase 5) ==============

// Single-window tax remittance view. Mirrors the new
// `GET /api/accounting/tax/summary` endpoint. Shows:
//   1. Tax collected on invoices (with per-rate breakdown)
//   2. Tax paid on expenses (business-use only, per-rate breakdown)
//   3. Net remittance (collected − paid)
// Plus a CSV download that drops the same numbers into a spreadsheet.
function TaxSummaryTab() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      setData(await fetchJson('/accounting/tax/summary' + (q ? '?' + q : '')));
      setErr('');
    } catch (e) { setErr(String(e)); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  // Helper that pivots on a budget-quarter label if the user picked a
  // typical remittance period (a quarter or a year). Defaults to the
  // empty window = "all-time" because the operator often wants the
  // grand-totals view at first load.
  const setQuarter = (year, qIdx) => {
    const start = new Date(year, qIdx * 3, 1);
    const end = new Date(year, qIdx * 3 + 3, 0); // day 0 of next month = last day of target month
    setFrom(start.toISOString().slice(0, 10));
    setTo(end.toISOString().slice(0, 10));
  };
  const thisQuarterIdx = () => Math.floor(new Date().getMonth() / 3);
  const thisYear = new Date().getFullYear();
  const qIdx = thisQuarterIdx();

  const csvHref = () => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    qs.set('format', 'csv');
    return `/api/accounting/tax/summary?${qs.toString()}`;
  };

  const openPrintable = async () => {
    setPrinting(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const payload = await fetchJson('/accounting/tax/pdf-ready' + (qs.toString() ? '?' + qs.toString() : ''));
      // Persist on sessionStorage then open a new tab. The
      // TaxSummaryPrintable route (added to App.jsx) reads it.
      sessionStorage.setItem('taxSummary.printable', JSON.stringify(payload));
      window.open('/accounting/tax-summary/print', '_blank', 'noopener,noreferrer');
    } catch (e) { setErr(String(e)); }
    finally { setPrinting(false); }
  };

  return (
    <div>
      <div className="card mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={load}>Apply</button>
        <button className="btn-ghost text-xs" onClick={() => { setFrom(''); setTo(''); }}>Clear</button>
        <div className="flex flex-wrap gap-1 ml-auto">
          <span className="text-xs text-slate-500 self-center mr-1">Quarters:</span>
          {[0, 1, 2, 3].map((i) => (
            <button
              key={i}
              className="btn-ghost text-xs"
              onClick={() => setQuarter(thisYear, i)}
              disabled={i > qIdx + 1 /* future */ && thisYear === new Date().getFullYear()}
            >
              Q{i + 1} {thisYear}
            </button>
          ))}
        </div>
        <div className="basis-full flex items-center gap-2 pt-2 border-t border-slate-100">
          <a className="btn-secondary text-xs" href={csvHref()} download>
            <FileSpreadsheet size={14} /> Download CSV
          </a>
          <button className="btn-ghost text-xs" onClick={openPrintable} disabled={printing} title="Open printable view in a new tab">
            <Printer size={14} /> Printable view
          </button>
          <span className="text-xs text-slate-500 ml-auto">
            All-time when no dates set. Drafts and cancelled invoices are excluded; personal expenses (business_use = 0) are excluded from the tax-paid side.
          </span>
        </div>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      {!data && <div>Loading…</div>}
      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <KPI
              label="Tax collected (invoices)"
              value={formatMoney(data.invoice_window.tax_collected_cents)}
              sub={`${data.invoice_window.invoice_count} invoice${data.invoice_window.invoice_count === 1 ? '' : 's'} · ${formatMoney(data.invoice_window.grand_total_cents)} gross`}
              icon={Receipt}
              color="text-green-700"
            />
            <KPI
              label="Tax paid (expenses, business use)"
              value={formatMoney(data.expense_window.tax_paid_cents)}
              sub={`${data.expense_window.expense_count} expense${data.expense_window.expense_count === 1 ? '' : 's'} · ${formatMoney(data.expense_window.total_cents)} total`}
              icon={DollarSign}
              color="text-orange-700"
            />
            <KPI
              label="Net remittance"
              value={formatMoney(data.net_remittance_cents)}
              sub={data.net_remittance_cents > 0
                ? 'Owe tax to CRA'
                : data.net_remittance_cents < 0
                  ? 'ITC / refund situation'
                  : 'Even — no remittance'}
              icon={Calculator}
              color={moneyColor(data.net_remittance_cents)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <ReportTable
              title="Tax collected — by rate"
              headers={['Label', 'Rate', 'Amount']}
              rows={(data.invoice_window.breakdown || []).map((b) => [
                b.label,
                b.rate != null ? (Number(b.rate) * 100).toFixed(3) + '%' : '—',
                formatMoney(b.amount_cents),
              ])}
              empty="No tax collected in this window."
            />
            <ReportTable
              title="Tax paid — by rate"
              headers={['Label', 'Rate', 'Count', 'Amount']}
              rows={(data.expense_window.breakdown || []).map((b) => [
                b.label,
                b.rate_bps != null ? (Number(b.rate_bps) / 100).toFixed(2) + '%' : '—',
                b.expense_count,
                formatMoney(b.amount_cents),
              ])}
              empty="No expenses with business-use tax in this window."
            />
          </div>

          <details className="card">
            <summary className="cursor-pointer text-sm text-slate-700 font-semibold">
              What's in the CSV?
            </summary>
            <ul className="text-xs text-slate-600 list-disc ml-5 mt-2 space-y-1">
              <li>One row per contributing (source, label, rate) tuple — invoice + expense sides.</li>
              <li>Three trailing TOTAL rows: tax collected, tax paid, net remittance.</li>
              <li>Cell values are integer cents. Apply `=Amount / 100` to get dollars, or import via Data → From Text/CSV.</li>
              <li>RFC-4180 quoted (Excel + LibreOffice + QuickBooks round-trip cleanly).</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

// ============== Reports ==============

function ReportsTab() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pnl, setPnl] = useState(null);
  const [byCustomer, setByCustomer] = useState([]);
  const [byProduct, setByProduct] = useState([]);
  const [byCategory, setByCategory] = useState([]);
  const [tax, setTax] = useState(null);
  const [outstanding, setOutstanding] = useState([]);
  const [paid, setPaid] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      const [p, c, bp, ec, t, o] = await Promise.all([
        fetchJson('/accounting/reports/pnl' + (q ? '?' + q : '')),
        fetchJson('/accounting/reports/sales-by-customer' + (q ? '?' + q : '')),
        fetchJson('/accounting/reports/sales-by-product' + (q ? '?' + q : '')),
        fetchJson('/accounting/reports/expenses-by-category' + (q ? '?' + q : '')),
        fetchJson('/accounting/reports/tax-collected' + (q ? '?' + q : '')),
        fetchJson('/accounting/reports/outstanding'),
      ]);
      setPnl(p); setByCustomer(c); setByProduct(bp); setByCategory(ec); setTax(t); setOutstanding(o);
      // Paid invoices list — derived from /invoices (status=paid) and date-filtered client-side
      const allInv = await fetchJson('/invoices');
      setPaid(allInv.filter((i) => i.status === 'paid').slice(0, 100));
    } catch (e) { setErr(String(e)); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="card mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={load}>Apply</button>
        <button className="btn-ghost text-xs" onClick={() => { setFrom(''); setTo(''); }}>Clear</button>
        <div className="flex-1" />
        <div className="text-xs text-slate-500">All-time when no dates set.</div>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      {pnl && (
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="card"><div className="text-xs text-slate-500 uppercase">Income</div><div className="text-2xl font-semibold text-green-700">{formatMoney(pnl.income_cents)}</div></div>
          <div className="card"><div className="text-xs text-slate-500 uppercase">Expenses</div><div className="text-2xl font-semibold text-orange-700">{formatMoney(pnl.expense_cents)}</div></div>
          <div className="card"><div className="text-xs text-slate-500 uppercase">Net</div><div className={`text-2xl font-semibold ${moneyColor(pnl.net_cents)}`}>{formatMoney(pnl.net_cents)}</div></div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ReportTable
          title="Sales by customer"
          headers={['Customer', 'Invoices', 'Sales']}
          rows={byCustomer.map((r) => [r.name, r.invoice_count, formatMoney(r.sales_cents)])}
          empty="No sales in this range."
        />
        <ReportTable
          title="Sales by product / service"
          headers={['Product', 'Units', 'Invoices', 'Gross', 'Net (excl. tax)']}
          rows={byProduct.map((r) => [
            r.product_name,
            r.units_sold,
            r.invoice_count,
            formatMoney(r.gross_cents),
            formatMoney(r.net_cents),
          ])}
          empty="No product sales in this range."
        />
        <ReportTable
          title="Expenses by category"
          headers={['Category', 'Count', 'Amount']}
          rows={byCategory.map((r) => [r.category, r.expense_count, formatMoney(r.amount_cents)])}
          empty="No expenses in this range."
        />
        <ReportTable
          title="Tax collected (invoices)"
          headers={['Invoices', 'Tax collected']}
          rows={tax ? [[tax.invoice_count, formatMoney(tax.total_tax_cents)]] : []}
          empty="No invoices in this range."
        />
        <ReportTable
          title="Outstanding invoices"
          headers={['#', 'Customer', 'Status', 'Due', 'Total']}
          rows={outstanding.map((i) => [i.invoice_uid, i.customer_name, i.status, fmtDate(i.due_at), formatMoney(i.total_cents)])}
          empty="No outstanding invoices. 🎉"
        />
      </div>

      <div className="mt-3">
        <ReportTable
          title="Paid invoices (last 100)"
          headers={['#', 'Customer', 'Total', 'Paid at']}
          rows={paid.map((i) => [i.invoice_uid, i.customer_name, formatMoney(i.total_cents), fmtDate(i.paid_at || i.due_at)])}
          empty="No paid invoices yet."
        />
      </div>
    </div>
  );
}

function ReportTable({ title, headers, rows, empty }) {
  return (
    <section className="card overflow-hidden p-0">
      <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 font-semibold text-sm">{title}</div>
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-slate-500 text-sm">{empty}</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>{headers.map((h, i) => <th key={i} className={`px-3 py-1.5 ${i === headers.length - 1 ? 'text-right' : ''}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((c, j) => <td key={j} className={`px-3 py-1.5 font-mono text-xs ${j === headers.length - 1 ? 'text-right' : ''}`}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ============== Audit Log ==============

function AuditTab() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      qs.set('limit', '200');
      const data = await fetchJson('/audit?' + qs.toString());
      // The general audit endpoint isn't filtered to accounting-only; we
      // surface the same list but let the operator filter by free text.
      setRows(data);
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!q) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) =>
      `${r.action} ${r.target || ''} ${r.payload || ''}`.toLowerCase().includes(needle)
    );
  }, [rows, q]);

  return (
    <div>
      <div className="card mb-3 flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              className="input pl-8"
              placeholder="Filter by action, target, or payload…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <button className="btn-secondary text-xs" onClick={load}>Refresh</button>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Payload</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan="4" className="px-3 py-6 text-center text-slate-500 text-sm">No audit events match.</td></tr>
            )}
            {filtered.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.target || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-600 max-w-md truncate" title={r.payload || ''}>
                  {r.payload || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Showing up to 200 most-recent events. Use the search box to filter.
      </p>
    </div>
  );
}

// ============== Import (QBO / CSV) ==============

function ImportTab() {
  const [entity, setEntity] = useState('customers');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const doPreview = async () => {
    setBusy(true); setErr(''); setPreview(null);
    try {
      const r = await postJson('/accounting/import/csv/preview', { entity, csv });
      setPreview(r);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };
  const doCommit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await postJson('/accounting/import/csv/commit', { entity, csv });
      alert(`Imported ${r.inserted_count} record(s).`);
      setPreview(null);
      setCsv('');
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
    finally { setBusy(false); }
  };

  const handleFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
  };

  return (
    <div>
      <div className="card mb-3">
        <p className="text-xs text-slate-600 mb-2">
          Paste CSV or upload a file. Headers from QuickBooks Online exports are auto-detected; you can paste a CSV with extra columns and the mapper will skip unknowns.
        </p>
        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex flex-wrap items-end gap-2 mb-2">
          <div>
            <label className="label">Entity</label>
            <select className="input" value={entity} onChange={(e) => { setEntity(e.target.value); setPreview(null); }}>
              <option value="customers">Customers</option>
              <option value="items">Products / Services (items)</option>
            </select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="label">CSV file</label>
            <input type="file" accept=".csv,text/csv" onChange={(e) => handleFile(e.target.files?.[0])} className="text-xs" />
          </div>
          <button className="btn-primary" onClick={doPreview} disabled={busy || !csv.trim()}>
            <FileUp size={14}/> Preview import
          </button>
        </div>
        <textarea
          className="input font-mono text-xs"
          rows="8"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="Paste CSV here. First row should be headers (e.g. Customer,Email,Phone,Company,… or Item,SKU,Sales Price,Description,…)"
        />
      </div>

      {preview && (
        <div className="card">
          <h3 className="font-semibold mb-2">Import preview</h3>
          <div className="text-xs text-slate-600 mb-2">
            {preview.creatable} creatable · {preview.skippable} skippable · {preview.total_rows} total rows
            {preview.unknown_headers?.length > 0 && (
              <span className="ml-2 text-amber-700">Unknown headers: {preview.unknown_headers.join(', ')}</span>
            )}
          </div>
          {preview.records?.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left">
                  <tr>
                    <th className="px-2 py-1.5">Status</th>
                    {Object.keys(preview.records[0]).map((k) => <th key={k} className="px-2 py-1.5">{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {preview.records.map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1.5">
                        {r._issues?.length ? <span className="badge-yellow" title={r._issues.join('; ')}>issue</span> : <span className="badge-green">ok</span>}
                      </td>
                      {Object.entries(r).filter(([k]) => k !== '_issues').map(([k, v]) => (
                        <td key={k} className="px-2 py-1.5 font-mono">{String(v ?? '').slice(0, 60)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.issues?.length > 0 && (
            <div className="mt-2 text-xs text-amber-700">
              <div className="font-semibold">Issues:</div>
              <ul className="list-disc list-inside">
                {preview.issues.slice(0, 10).map((i, k) => <li key={k}>Row {i.row}: {i.message}</li>)}
              </ul>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={doCommit} disabled={busy || !preview.creatable}>
              <Save size={14}/> Commit {preview.creatable} record(s)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== Backups ==============

function BackupsTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    try { setData(await fetchJson('/accounting/backups')); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, []);

  const createBackup = async () => {
    setBusy(true); setErr('');
    try { await postJson('/accounting/backup', {}); await load(); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const restoreBackup = async (filename) => {
    if (!window.confirm(`Restore from ${filename}? This replaces the live database. The server will reopen the DB on the next request.`)) return;
    setBusy(true); setErr('');
    try { await postJson('/accounting/restore', { filename }); await load(); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card mb-3 flex items-center justify-between">
        <div>
          <div className="font-semibold">Local backups</div>
          <div className="text-xs text-slate-600">Snapshots of the SQLite database. Stored under <code className="text-xs">{data?.root}</code>.</div>
        </div>
        <button className="btn-primary" onClick={createBackup} disabled={busy}>
          <Database size={14}/> Create backup
        </button>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Filename</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.backups || []).length === 0 && (
              <tr><td colSpan="4" className="px-3 py-6 text-center text-slate-500 text-sm">No backups yet. Click "Create backup" to take a snapshot.</td></tr>
            )}
            {data?.backups.map((b) => (
              <tr key={b.filename} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{b.filename}</td>
                <td className="px-3 py-2 text-right text-xs text-slate-600">{(b.size_bytes / 1024).toFixed(1)} KB</td>
                <td className="px-3 py-2 text-xs">{fmtDateTime(b.mtime)}</td>
                <td className="px-3 py-2 text-right">
                  <button className="btn-ghost text-xs" onClick={() => restoreBackup(b.filename)} disabled={busy} title="Restore">
                    <RotateCcw size={12}/> Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============== Accountant Export (Phase 6) ==============
//
// The accountant export bundle gives Byron (and his accountant) a
// practical QuickBooks-free handoff package. Six endpoints under
// /api/accounting/export/* produce one of the canonical CSVs (with
// integer-cent + decimal-string columns, an echoed `generated_at` on
// every row, and `from` / `to` range echo) plus a `manifest.json`
// metadata file plus a `bundle.zip` archive that includes all of the
// above. The download flow is intentionally browser-native — clicking
// a button issues a request to /api/accounting/export/* and lets the
// browser save the response with the right `Content-Disposition`
// filename. No client-side parsing of CSV/ZIP, no secrets exposed
// (Stripe / Gmail / session / cookies / internal IDs are explicitly
// excluded from the row columns), no QuickBooks dependency.
function ExportTab() {
  // Default window = current calendar year so the "first-run" preview
  // is a sensible slice instead of the full multi-year history.
  const today = new Date();
  const yearStart = `${today.getFullYear()}-01-01`;
  const todayStr = today.toISOString().slice(0, 10);
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(todayStr);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [manifest, setManifest] = useState(null);
  const [preview, setPreview] = useState(null); // { name, rows, headers }
  const [loadingPreview, setLoadingPreview] = useState(false);

  const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  // Hits the API and lets the browser save the response with the
  // server-supplied Content-Disposition filename. We do NOT set
  // `responseType: 'blob'` in axios here because the server's
  // `Content-Type: application/zip` is non-text and axios will
  // produce a string by default — we need an actual blob so the
  // browser triggers a download.
  const download = async (path, label) => {
    setBusy(label); setErr('');
    try {
      const res = await api.get(path, { responseType: 'blob' });
      // Server filename is the source of truth (e.g.
      // "invoices-2026-01-01-to-2026-06-30.csv"). Parse the
      // Content-Disposition header to pull it out.
      const cd = res.headers?.['content-disposition'] || '';
      const m = cd.match(/filename="?([^";]+)"?/);
      const filename = m ? m[1] : `${label}-${todayStr}`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(`Download failed: ${String(e?.message ?? e)}`);
    } finally {
      setBusy('');
    }
  };

  // Load the manifest as a sanity check that the endpoints are wired
  // and to surface the bundle metadata (generated_at, schema notes)
  // before the user clicks anything.
  const loadManifest = useCallback(async () => {
    setErr('');
    try {
      const m = await fetchJson(`/accounting/export/manifest.json?${range}`);
      setManifest(m);
    } catch (e) {
      setErr(`Manifest load failed: ${String(e?.message ?? e)}`);
    }
  }, [from, to]);

  useEffect(() => { loadManifest(); }, [loadManifest]);

  // Preview a single CSV inline so the operator can sanity-check row
  // shape before sending the file to the accountant. The server
  // returns text/csv; we read the first 50 lines client-side. We do
  // NOT attempt a full RFC-4180 parse here — this is a preview, not
  // a verifier; the test suite has the real parser.
  const previewCsv = async (name, path) => {
    setLoadingPreview(true); setErr(''); setPreview(null);
    try {
      const text = await fetchJson(`/accounting/export/${path}?${range}`);
      const lines = String(text).split(/\r?\n/).filter(Boolean);
      const rows = lines.slice(0, 51).map((l) => l.split(','));
      setPreview({ name, rows });
    } catch (e) {
      setErr(`Preview failed: ${String(e?.message ?? e)}`);
    } finally {
      setLoadingPreview(false);
    }
  };

  const EXPORTS = [
    { key: 'invoices.csv',  label: 'Invoices',     path: 'invoices.csv',  desc: 'One row per invoice with line-items and tax breakdown JSON.' },
    { key: 'payments.csv',  label: 'Payments',     path: 'payments.csv',  desc: 'One row per payment; no Stripe / charge IDs.' },
    { key: 'expenses.csv',  label: 'Expenses',     path: 'expenses.csv',  desc: 'One row per expense with category + tax-rate join.' },
    { key: 'customers.csv', label: 'Customers',    path: 'customers.csv', desc: 'Full customer list (all dates).' },
    { key: 'tax-summary.csv', label: 'Tax summary', path: 'tax-summary.csv', desc: 'Tax collected / paid rows + total + net remittance.' },
  ];

  return (
    <div>
      <div className="card mb-3">
        <div className="font-semibold mb-1">Date range</div>
        <p className="text-xs text-slate-600 mb-3">
          Defaults to the current calendar year. Customers export ignores the range; everything else
          is filtered by invoice <code className="text-xs">created_at</code> / payment{' '}
          <code className="text-xs">received_at</code> / expense <code className="text-xs">expense_date</code>.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs">
            <span className="text-slate-500 mb-1">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
          </label>
          <label className="flex flex-col text-xs">
            <span className="text-slate-500 mb-1">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
          </label>
          <button className="btn-ghost text-xs" onClick={() => { setFrom('1970-01-01'); setTo('2999-12-31'); }}>
            <RefreshCw size={12}/> All time
          </button>
        </div>
      </div>

      {err && <div className="card text-red-600 mb-3">{err}</div>}

      <div className="card mb-3">
        <div className="flex items-center justify-between mb-1">
          <div className="font-semibold">Bundle (ZIP)</div>
          {manifest && <span className="text-xs text-slate-500">manifest v{manifest.version} · {manifest.files.length} files</span>}
        </div>
        <p className="text-xs text-slate-600 mb-3">
          One download with all CSVs + <code className="text-xs">manifest.json</code> inside. Each file
          echoes the same <code className="text-xs">generated_at</code> timestamp so multi-table pivots
          line up in a spreadsheet. Every audit-logged download is recorded (see Audit Log tab).
        </p>
        <button
          className="btn-primary"
          onClick={() => download(`/accounting/export/bundle.zip?${range}`, 'bundle')}
          disabled={!!busy}
        >
          <Download size={14}/> {busy === 'bundle' ? 'Preparing…' : 'Download bundle.zip'}
        </button>
        {manifest && (
          <details className="mt-3 text-xs text-slate-600">
            <summary className="cursor-pointer">Manifest details</summary>
            <pre className="mt-2 p-2 bg-slate-50 rounded text-[11px] overflow-auto">
{`generated_at: ${manifest.generated_at}
from:         ${manifest.from}
to:           ${manifest.to}
files:        ${manifest.files.join(', ')}

${Object.entries(manifest.schema_notes).map(([k, v]) => `${k}: ${v}`).join('\n\n')}`}
            </pre>
          </details>
        )}
      </div>

      <div className="card mb-3">
        <div className="font-semibold mb-2">Individual CSVs</div>
        <p className="text-xs text-slate-600 mb-3">
          Same data as the bundle, one file at a time. Useful when the accountant only needs
          one table (e.g. just the tax summary for a remittance period).
        </p>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {EXPORTS.map((x) => (
              <tr key={x.key} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{x.path}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{x.desc}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    className="btn-ghost text-xs mr-1"
                    onClick={() => previewCsv(x.path, x.path)}
                    disabled={loadingPreview}
                    title="Preview first 50 rows"
                  >
                    <Eye size={12}/> Preview
                  </button>
                  <button
                    className="btn-primary text-xs"
                    onClick={() => download(`/accounting/export/${x.path}?${range}`, x.path.replace('.csv', ''))}
                    disabled={!!busy}
                  >
                    <Download size={12}/> {busy === x.path.replace('.csv', '') ? '…' : 'Download'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Preview · {preview.name} (first 50 rows)</div>
            <button className="btn-ghost text-xs" onClick={() => setPreview(null)}>
              <X size={12}/> Close
            </button>
          </div>
          <div className="overflow-auto max-h-96 border border-slate-200 rounded">
            <table className="text-[11px] font-mono">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  {preview.rows[0]?.map((h, i) => (
                    <th key={i} className="px-2 py-1 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(1).map((r, ri) => (
                  <tr key={ri} className="border-t border-slate-100">
                    {r.map((c, ci) => (
                      <td key={ci} className="px-2 py-1 whitespace-nowrap">{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Preview shows raw CSV cells. Money is in <code>integer cents</code> + a <code>decimal</code> string.
            Open the downloaded file in Excel / Numbers for the canonical view.
          </p>
        </div>
      )}
    </div>
  );
}

// ============== shared UI bits ==============

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const handler = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-slate-900/40 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="font-semibold">{title}</div>
          <button className="btn-ghost text-xs" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
