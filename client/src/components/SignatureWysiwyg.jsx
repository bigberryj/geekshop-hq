/**
 * SignatureWysiwyg — small WYSIWYG editor for the outbound email
 * signature.
 *
 * Storage contract (unchanged from previous iterations):
 *   - `settings.email_signature_html` — the rich signature as HTML.
 *     This component writes to that exact column.
 *
 * The on-disk value is the *inner HTML* of the editing region. On
 * every "save" (explicit button or blur) we sanitize the content
 * against the same allowlist the server uses (mirror of
 * server/lib/signature.js sanitizeRichSignature), so a stray paste
 * of `<script>` or `javascript:` is scrubbed client-side too —
 * defense in depth.
 *
 * Implementation notes:
 * - Built on `contentEditable` + `document.execCommand` for the
 *   basic toolbar (B/I/U/H/P/lists/link/image/clear). execCommand
 *   is deprecated in the spec but still works in every shipping
 *   browser (Chromium, Firefox, Safari, Edge) and avoids pulling in
 *   a 200KB editor like TipTap or Quill.
 * - Table insertion is NOT supported by execCommand in any browser,
 *   so we build the table HTML ourselves, insert it at the caret
 *   via Range.insertNode, and then focus the first cell. Borders
 *   and border colors use inline `style="border:…"` attributes; the
 *   server's sanitizer keeps the table/tr/td/tags and `style`
 *   attributes intact, so what you see in the editor is exactly
 *   what lands in the email.
 * - "Border off" is represented by `style="border:0"` on the table
 *   and each cell — a single token we can toggle on/off reliably
 *   without trying to remove other inline styles the admin may
 *   have added (cell padding, width, background, etc.).
 * - "Border color" is a small allowlist of safe hex colors that
 *   matches the color picker in the Settings plain editor; admins
 *   who need an exact brand color can edit the HTML directly.
 * - We never write user input directly via `dangerouslySetInnerHTML`
 *   into the editor — we read from it on save. The server also
 *   re-sanitizes on read, so even a malicious admin can't get a
 *   dangerous value to land in an email.
 * - Toolbar is keyboard accessible (real <button>s).
 *
 * Props:
 *   value:        string — current HTML (controlled)
 *   onSave:       (html: string) => void — called when the user
 *                  commits (button click or blur)
 *   onCancel?:    () => void — optional cancel handler
 */
import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Mirror of server/lib/signature.js sanitizeRichSignature. Strip
 * anything dangerous from the editor's HTML before we ship it to
 * the server. Keep these two functions in sync; if you add a tag
 * or attribute here, also add it server-side.
 *
 * Note: we keep this sanitizer LOSSY only on dangerous content
 * (script/iframe/event-handlers/javascript: URLs). Everything in the
 * table/border feature goes through the server's allowlist, which
 * already permits <table>/<tr>/<td>/<th>, `border`, `cellpadding`,
 * `cellspacing`, `style`, and the standard colors we use.
 */
function sanitizeLocal(html) {
  if (!html || typeof html !== 'string') return '';
  // Drop script/style/iframe/object/embed/form/link/meta/base (with body)
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');
  // Strip on* handlers
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
  // Strip dangerous URL schemes in href/src
  s = s.replace(/(\s(?:href|src)\s*=\s*")\s*(?:javascript|data|vbscript|file):[^"]*"/gi, '$1#"');
  s = s.replace(/(\s(?:href|src)\s*=\s*')\s*(?:javascript|data|vbscript|file):[^']*'/gi, "$1#'");
  s = s.replace(/(\s(?:href|src)\s*=\s*)(?:javascript|data|vbscript|file):[^\s>]+/gi, '$1#');
  // Drop <font> tags entirely (admin can use color via inline span)
  s = s.replace(/<font\b[^>]*>/gi, '').replace(/<\/font\s*>/gi, '');
  return s;
}

/** Convert the editor's HTML into a stable canonical form. We trim
 * trailing whitespace inside the container and collapse runs of
 * empty <p> / <br> at the tail. */
function normalizeHtml(html) {
  if (!html) return '';
  // Replace <div><br></div> with <br/> (Chromium's empty paragraph)
  let s = html.replace(/<div><br\s*\/?><\/div>/gi, '<br/>');
  // Strip trailing <br> and empty <p></p>
  s = s.replace(/(<br\s*\/?>)+$/i, '');
  s = s.replace(/(<p>\s*<\/p>)+$/i, '');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Table builder
// ---------------------------------------------------------------------------

/** Safe hex colors for the border picker. Mirrors the brand palette
 * used elsewhere in HQ (slate, brand, red/amber/green). Anything not
 * in this list is rejected — admins who need an exact brand color
 * can hand-edit the HTML in the saved value. The server sanitizer
 * does NOT enforce this allowlist (style: accepts any color string),
 * so this is purely a UX safeguard; the real safety net is the
 * server's stripping of dangerous content from style values
 * (expression/javascript:/behavior:). */
const BORDER_COLORS = [
  { hex: '#e5e7eb', name: 'slate' },
  { hex: '#475569', name: 'dark slate' },
  { hex: '#000000', name: 'black' },
  { hex: '#dc2626', name: 'red' },
  { hex: '#d97706', name: 'amber' },
  { hex: '#059669', name: 'green' },
  { hex: '#2563eb', name: 'blue' },
  { hex: '#7c3aed', name: 'purple' },
];

/** Build a fresh table HTML string with the given rows/cols and a
 * uniform border style on the table itself and each cell. Returns
 * raw HTML suitable for `Range.insertNode`. */
function buildTableHtml(rows, cols, { borderColor = '#e5e7eb', borderWidth = '1' } = {}) {
  const safeColor = BORDER_COLORS.some((c) => c.hex === borderColor) ? borderColor : '#e5e7eb';
  const safeWidth = ['0', '1', '2', '3', '4'].includes(String(borderWidth)) ? String(borderWidth) : '1';
  const borderStyle = `${safeWidth}px solid ${safeColor}`;
  const cellStyle = `border: ${borderStyle}; padding: 4px 8px;`;
  const tableStyle = `border-collapse: collapse; border: ${borderStyle};`;
  const rowsHtml = [];
  for (let r = 0; r < rows; r += 1) {
    const cellsHtml = [];
    for (let c = 0; c < cols; c += 1) {
      cellsHtml.push(`<td style="${cellStyle}"><br/></td>`);
    }
    rowsHtml.push(`<tr>${cellsHtml.join('')}</tr>`);
  }
  return `<table style="${tableStyle}">${rowsHtml.join('')}</table>`;
}

/** True if the editor's selection (or any ancestor of it) is a
 * `<table>` element. */
function selectionIsInsideTable() {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || !sel.rangeCount) return false;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (!node) return false;
  if (node.nodeType === 3 /* text */) node = node.parentNode;
  while (node && node !== document.body) {
    if (node.nodeType === 1 && node.tagName === 'TABLE') return true;
    node = node.parentNode;
  }
  return false;
}

/** Find the closest ancestor `<table>` of the current selection (or
 * null). Used to apply border updates to the table the cursor is in. */
function findSelectionTable() {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (!node) return null;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== document.body) {
    if (node.nodeType === 1 && node.tagName === 'TABLE') return node;
    node = node.parentNode;
  }
  return null;
}

/** Apply a CSS `border` declaration to a table AND every <td>/<th>
 * in it. Other inline styles on cells (padding, width, background,
 * etc.) are preserved. If `borderStyle` is null/empty, the border
 * declaration is removed instead of replaced. */
function applyBorderToTable(table, borderStyle /* string | null */) {
  if (!table) return;
  // Update table-level border-collapse and border shorthand on the
  // <table> style.
  const tableStyle = table.getAttribute('style') || '';
  const newTableStyle = borderStyle
    ? mergeStyle(tableStyle, { border: borderStyle, 'border-collapse': 'collapse' })
    : removeStyleProps(tableStyle, ['border', 'border-collapse']);
  if (newTableStyle) {
    table.setAttribute('style', newTableStyle);
  } else {
    table.removeAttribute('style');
  }
  // Update each cell. <thead>/<tbody>/<tfoot> are structural
  // pass-throughs; we walk directly to <td>/<th>.
  const cells = table.querySelectorAll('th, td');
  cells.forEach((cell) => {
    const cellStyle = cell.getAttribute('style') || '';
    const next = borderStyle
      ? mergeStyle(cellStyle, { border: borderStyle })
      : removeStyleProps(cellStyle, ['border']);
    if (next) cell.setAttribute('style', next);
    else cell.removeAttribute('style');
  });
}

/** Merge a set of CSS declarations into an existing style string,
 * replacing any existing values for the same keys. */
function mergeStyle(styleStr, props) {
  // Parse existing declarations into a map, then overwrite/add.
  const map = new Map();
  styleStr.split(';').forEach((decl) => {
    const i = decl.indexOf(':');
    if (i === -1) return;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim();
    if (k) map.set(k, v);
  });
  Object.entries(props).forEach(([k, v]) => map.set(k.toLowerCase(), v));
  return Array.from(map.entries()).map(([k, v]) => `${k}: ${v}`).join('; ');
}

/** Remove the given style properties from a style string. */
function removeStyleProps(styleStr, keys) {
  const drop = new Set(keys.map((k) => k.toLowerCase()));
  const parts = styleStr.split(';');
  const kept = parts.filter((decl) => {
    const i = decl.indexOf(':');
    if (i === -1) return false;
    const k = decl.slice(0, i).trim().toLowerCase();
    return !drop.has(k);
  }).map((d) => d.trim()).filter(Boolean);
  return kept.join('; ');
}

// ---------------------------------------------------------------------------
// Toolbar definition
// ---------------------------------------------------------------------------

const BASE_TOOLBAR_GROUPS = [
  [
    { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', style: 'font-bold' },
    { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', style: 'italic' },
    { cmd: 'underline', label: 'U', title: 'Underline (Ctrl+U)', style: 'underline' },
  ],
  [
    { cmd: 'formatBlock', arg: 'H2', label: 'H', title: 'Heading' },
    { cmd: 'formatBlock', arg: 'P', label: '¶', title: 'Paragraph' },
  ],
  [
    { cmd: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
    { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  ],
  [
    { cmd: 'createLink', label: '🔗 Link', title: 'Insert/edit link', needsPrompt: true },
    { cmd: 'insertImage', label: '🖼 Img', title: 'Insert image (URL)', needsPrompt: true },
  ],
  [
    { cmd: 'insertTable', label: '⊞ Table', title: 'Insert table (rows × cols)', needsTablePrompt: true },
    { cmd: 'removeFormat', label: 'Clear', title: 'Clear formatting' },
  ],
];

export default function SignatureWysiwyg({ value, onSave, onCancel }) {
  const editorRef = useRef(null);
  const [savedHtml, setSavedHtml] = useState(value || '');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);
  // Force a re-render of the toolbar so the Table-mode group
  // appears/disappears as the cursor enters/leaves a <table>.
  const [, setSelectionTick] = useState(0);

  // When the parent's `value` changes (e.g. after a server roundtrip
  // following another tab's edit), sync the editor — but ONLY if
  // the user isn't currently dirty, to avoid clobbering an in-flight edit.
  useEffect(() => {
    if (dirty) return;
    if ((value || '') !== savedHtml) {
      setSavedHtml(value || '');
      if (editorRef.current) editorRef.current.innerHTML = value || '';
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial mount: paint the editor.
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.innerHTML = value || '';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runCommand = useCallback((cmd, arg) => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    // execCommand returns false if the browser refuses the command
    // (e.g. inside an iframe without permission). We ignore the
    // return value here — the user can retry.
    document.execCommand(cmd, false, arg ?? null);
    setDirty(true);
  }, []);

  const handlePrompt = useCallback((cmd, title) => {
    const url = window.prompt(title);
    if (!url) return;
    if (cmd === 'createLink') {
      // Make sure http(s):// is present so the sanitizer accepts it.
      let u = url.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
        u = `https://${u}`;
      }
      runCommand(cmd, u);
    } else {
      runCommand(cmd, url.trim());
    }
  }, [runCommand]);

  /** Prompt for rows × cols (e.g. "3x3") then insert a fresh table
   * at the current caret position. Default border style is applied
   * so the table is immediately visible. */
  const insertTable = useCallback(() => {
    const raw = window.prompt('Insert table — rows × cols (e.g. "3x3"):', '3x3');
    if (!raw) return;
    const m = String(raw).trim().match(/^(\d{1,2})\s*[xX×]\s*(\d{1,2})$/);
    if (!m) {
      window.alert('Format must be "rows x cols" — for example, 3x3 or 2x4.');
      return;
    }
    const rows = Math.max(1, Math.min(20, parseInt(m[1], 10)));
    const cols = Math.max(1, Math.min(10, parseInt(m[2], 10)));
    const html = buildTableHtml(rows, cols);
    if (!editorRef.current) return;
    editorRef.current.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    // Make sure the insertion point is inside the editor.
    if (!editorRef.current.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
    }
    range.deleteContents();
    // Parse the HTML into a real node we can insert. The browser
    // will fix any malformed markup.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const table = tmp.firstChild;
    if (!table) return;
    // Place a <br> after the table so the caret has somewhere to go
    // when the user wants to type after the table.
    const trailingBr = document.createElement('br');
    range.insertNode(table);
    range.setStartAfter(table);
    range.setEndAfter(table);
    range.insertNode(trailingBr);
    range.setStartAfter(trailingBr);
    range.setEndAfter(trailingBr);
    sel.removeAllRanges();
    sel.addRange(range);
    setDirty(true);
  }, []);

  /** Apply a uniform border style to the table the caret is in. */
  const applyTableBorder = useCallback((widthPx, color) => {
    if (!editorRef.current) return;
    const table = findSelectionTable();
    if (!table) return;
    const width = ['0', '1', '2', '3', '4'].includes(String(widthPx))
      ? String(widthPx)
      : '1';
    const safeColor = BORDER_COLORS.some((c) => c.hex === color) ? color : '#e5e7eb';
    const borderStyle = width === '0' ? null : `${width}px solid ${safeColor}`;
    applyBorderToTable(table, borderStyle);
    setDirty(true);
  }, []);

  /** Toggle the table borders between "off" and "on with the last
   * used color". Track the last-used color in component state so
   * re-enabling borders after toggling them off returns to the
   * admin's previously-chosen color. */
  const toggleTableBorders = useCallback(() => {
    const table = findSelectionTable();
    if (!table) return;
    const current = table.getAttribute('style') || '';
    const hasBorder = /\bborder\s*:/i.test(current);
    if (hasBorder) {
      applyBorderToTable(table, null);
    } else {
      const lastColor = (() => {
        try {
          const stored = window.localStorage.getItem('j5_sig_border_color');
          if (stored && BORDER_COLORS.some((c) => c.hex === stored)) return stored;
        } catch (_) { /* localStorage may be disabled */ }
        return '#475569';
      })();
      applyBorderToTable(table, `1px solid ${lastColor}`);
    }
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    if (!editorRef.current) return;
    try {
      const raw = editorRef.current.innerHTML || '';
      const clean = normalizeHtml(sanitizeLocal(raw));
      setSavedHtml(clean);
      setDirty(false);
      setSavedAt(new Date());
      setError(null);
      onSave?.(clean);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [onSave]);

  const handleCancel = useCallback(() => {
    if (!editorRef.current) return;
    // Roll the editor back to the last saved value, drop unsaved edits.
    editorRef.current.innerHTML = savedHtml;
    setDirty(false);
    setError(null);
    onCancel?.();
  }, [savedHtml, onCancel]);

  const handleKeyDown = useCallback((e) => {
    // Ctrl/Cmd-S to save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  // When the selection moves inside the editor, recompute whether
  // we're inside a table so the toolbar re-renders with the
  // Table-mode group. We listen at the document level so we catch
  // caret moves that don't bubble through the editor's onInput.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onSelChange = () => {
      if (!editorRef.current) return;
      // Only react if the selection is inside the editor.
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const node = sel.getRangeAt(0).commonAncestorContainer;
      if (!editorRef.current.contains(node)) return;
      setSelectionTick((t) => t + 1);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, []);

  const inTable = (() => {
    if (typeof document === 'undefined') return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    if (!editorRef.current || !editorRef.current.contains(node)) return false;
    return selectionIsInsideTable();
  })();

  return (
    <div className="border border-slate-300 rounded-md bg-white" data-testid="sig-wysiwyg">
      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-slate-200 bg-slate-50 rounded-t-md"
        role="toolbar"
        aria-label="Signature formatting toolbar"
      >
        {BASE_TOOLBAR_GROUPS.map((group, gi) => (
          <div key={gi} className="flex items-center gap-0.5 pr-1 mr-1 border-r border-slate-200 last:border-r-0">
            {group.map((btn, bi) => (
              <button
                key={bi}
                type="button"
                title={btn.title}
                onMouseDown={(e) => e.preventDefault() /* keep editor focus */}
                onClick={() => {
                  if (btn.needsTablePrompt) insertTable();
                  else if (btn.needsPrompt) handlePrompt(btn.cmd, btn.title + ' (URL):');
                  else runCommand(btn.cmd, btn.arg);
                }}
                className={`px-2 py-1 text-xs rounded hover:bg-slate-200 text-slate-700 ${btn.style || ''}`}
                data-testid={`sig-tool-${btn.cmd}`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Table-mode toolbar — only visible when the caret is inside a table */}
      {inTable && (
        <div
          className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-amber-200 bg-amber-50"
          role="toolbar"
          aria-label="Table formatting toolbar"
          data-testid="sig-table-toolbar"
        >
          <span className="text-[11px] uppercase tracking-wide text-amber-700 font-semibold">Table:</span>
          <button
            type="button"
            title="Toggle table borders on/off"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleTableBorders}
            className="px-2 py-1 text-xs rounded border border-amber-300 bg-white hover:bg-amber-100 text-amber-900"
            data-testid="sig-table-borders-toggle"
          >
            Borders on/off
          </button>
          <label className="text-[11px] text-amber-900 flex items-center gap-1">
            Border color:
            <select
              onMouseDown={(e) => e.preventDefault()}
              onChange={(e) => {
                const hex = e.target.value;
                try { window.localStorage.setItem('j5_sig_border_color', hex); } catch (_) { /* noop */ }
                applyTableBorder('1', hex);
                // Reset to the default value so the same color can be re-picked.
                e.target.value = hex;
              }}
              className="text-xs border border-amber-300 rounded px-1 py-0.5 bg-white"
              data-testid="sig-table-border-color"
              defaultValue="#475569"
            >
              {BORDER_COLORS.map((c) => (
                <option key={c.hex} value={c.hex}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-amber-900 flex items-center gap-1">
            Width:
            <select
              onMouseDown={(e) => e.preventDefault()}
              onChange={(e) => applyTableBorder(e.target.value, '#475569')}
              className="text-xs border border-amber-300 rounded px-1 py-0.5 bg-white"
              data-testid="sig-table-border-width"
              defaultValue="1"
            >
              <option value="0">none</option>
              <option value="1">1px</option>
              <option value="2">2px</option>
              <option value="3">3px</option>
              <option value="4">4px</option>
            </select>
          </label>
        </div>
      )}

      {/* Editor region */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Email signature (rich)"
        data-testid="sig-wysiwyg-editor"
        onInput={() => setDirty(true)}
        onBlur={() => { if (dirty) handleSave(); }}
        onKeyDown={handleKeyDown}
        className="px-3 py-2 min-h-[120px] max-h-[300px] overflow-y-auto text-sm focus:outline-none"
        style={{ lineHeight: 1.5 }}
      />

      {/* Status + actions */}
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-t border-slate-200 bg-slate-50 rounded-b-md">
        <button
          type="button"
          onClick={handleSave}
          className="btn-secondary text-xs"
          data-testid="sig-wysiwyg-save"
        >
          Save signature
        </button>
        {dirty && (
          <button
            type="button"
            onClick={handleCancel}
            className="btn-ghost text-xs"
            data-testid="sig-wysiwyg-cancel"
          >
            Discard changes
          </button>
        )}
        <div className="ml-auto text-xs text-slate-500">
          {!dirty && savedAt && (
            <span data-testid="sig-saved-indicator">Saved {savedAt.toLocaleTimeString()}</span>
          )}
          {dirty && <span className="text-amber-700" data-testid="sig-dirty-indicator">Unsaved changes</span>}
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-600 px-2 py-1" role="alert">{error}</div>
      )}
    </div>
  );
}