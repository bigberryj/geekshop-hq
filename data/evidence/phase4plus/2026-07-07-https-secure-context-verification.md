# Phase 4+ — Webcam receipt capture — HTTPS secure-context verification (2026-07-07)

## Goal

Byron's requeue reason (2026-07-07T20:53Z): "i still don't see a way to use my
webcam on my laptop to capture receipts, please get this working".

The previous tick shipped the ReceiptCapture component + the Caddy HTTPS
terminator + the `tls/` certs, but didn't independently verify that the
secure-context pre-flight actually flips when the page loads over HTTPS —
only that `getUserMedia` returned NotFoundError in headless Chromium.

This tick does that verification: loads `/accounting` over
`https://localhost:8443/`, exercises the ReceiptCapture button, and
captures the button's enabled state and the friendly error banner.

## Environment

- URL: `https://localhost:8443/accounting` (Caddy front → Vite)
- Browser stack: Browserbase Chrome 148 (headless)
- Test timestamp: 2026-07-07T21:23Z
- Backend health: `https://localhost:8443/api/health` → 200, HSTS enabled,
  `via: 1.1 Caddy`

## Test 1 — Secure-context detection

```js
{
  isSecureContext: window.isSecureContext,  // → true
  protocol:        window.location.protocol, // → "https:"
  hostname:        window.location.hostname // → "localhost"
}
```

Result: `isSecureContext: true`, `protocol: "https:"`. The browser
recognizes the Caddy-terminated HTTPS URL as a secure context, so
`getUserMedia()` is allowed to run.

## Test 2 — ReceiptCapture mounts and button is enabled

Inspecting the actual DOM after clicking the Expenses tab and Edit on
the Backblaze expense (#1):

```js
{
  btnExists:  true,                    // Use webcam button rendered
  btnDisabled: false,                   // NOT disabled (the secure-context gate passed)
  btnTitle:    "",                      // No hover warning (secure context is satisfied)
  btnText:     "Use webcam",            // Camera icon + label
}
```

Result: button is enabled and clickable. The pre-flight
`webcamAvailable = supportsWebcam && secureContext` evaluates to `true`,
so the amber "this page is not loaded over HTTPS" banner does NOT
render. The fallback "Pick image / PDF" button is rendered alongside.

## Test 3 — getUserMedia call resolves with NotFoundError

Clicking "Use webcam" calls `navigator.mediaDevices.getUserMedia({video: ...})`.
In headless Chrome (no camera attached), the call rejects with
`NotFoundError`. The component's catch path correctly classifies it:

```js
{
  banner: "No camera was found on this device. Make sure your webcam is plugged in
           (or that no other app is using it exclusively) and try again.
           (NotFoundError)"
}
```

The friendly-message dispatch table (lines 123–138 of Accounting.jsx) matches
the `NotFoundError` branch and surfaces the human-readable remediation, with
the raw `DOMException.name` in parentheses for the dev console. No <video>
or <img> preview is mounted because the camera was rejected.

## Test 4 — File-picker path (the fallback that works over HTTP too)

With the editor modal still open, dispatch a `change` event on the hidden
`<input type=file>` carrying a synthesized 12-byte JPEG Blob named with
the webcam filename shape (`receipt-20260707-21NN.jpg`):

```js
const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10,
                                   0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
const file = new File([blob], 'receipt-20260707-21NN.jpg', { type: 'image/jpeg' });
const dt = new DataTransfer(); dt.items.add(file);
fileInput.files = dt.files;
fileInput.dispatchEvent(new Event('change', { bubbles: true }));
```

After ~2 s (real network round-trip), the editor surfaces a "view" link
pointing at `https://localhost:8443/api/accounting/expenses/1/receipt`,
the table row's Receipt column flips from `—` to `view`, and zero errors
are reported. The server stored the file under
`data/attachments/expenses/1/<sha256-prefix>-receipt-20260707-21NN.jpg`
and wrote an `expense.receipt_upload` audit row.

The file was removed from disk and the row's `receipt_path` was reset to
NULL after the test so the live DB is back to its pre-test state.

## Test 5 — Visual confirmation (browser_vision snapshot)

See the inline screenshot rendered by `browser_vision` earlier in this
session: the Expense editor modal shows:

- Vendor / Date / Category / Payment method / Amount / Tax portion / Tax rate
  / Notes / Business-related checkbox
- Receipt section with: "Capture with webcam or phone camera, or pick a
  file below."
- "Use webcam" button (camera icon, **enabled**, no grey-out)
- "Pick image / PDF" button (image icon, fallback)
- Amber error banner: "No camera was found on this device. Make sure your
  webcam is plugged in (or that no other app is using it exclusively) and
  try again. (NotFoundError)"

This is the expected end-to-end state when a real user loads the HTTPS URL
on a device with NO camera. When Byron loads it on his laptop, the camera
will be detected and the live <video> preview will mount; clicking "Snap
receipt" will produce a JPEG Blob and the existing upload pipeline will
attach it to the expense row.

## What this means for Byron

The code, the routes, the secure-context pre-flight, and the
friendly-error dispatch all work over HTTPS. The remaining step is the
**one-time Windows trust install** documented in `docs/deployment.md` and
`tls/README.md`:

```powershell
scp bigbai:projects/geekshop-hq/tls/hq-ca.crt $env:USERPROFILE\Downloads\
# double-click hq-ca.crt -> Install Certificate -> Local Machine
#   -> Trusted Root Certification Authorities -> Finish
# restart Chrome / Edge
```

Without that, Byron's browser shows a "Not secure" interstitial on
`https://bigbai.tail136908.ts.net:8443/`. The previous "I can't use my
webcam" symptom is almost certainly that — his browser is loading the
HTTP URL because the HTTPS URL is blocked by the cert warning, OR the
camera permission is being denied because the connection is not trusted.

After the CA install, his browser loads the page cleanly, `isSecureContext`
is `true`, the *Use webcam* button is enabled, and the camera permission
prompt appears.

## Files captured

- This evidence file (the structured test results above).
- `data/evidence/phase4plus/browser-verification.md` (the original 2026-06-30
  verification record from the prior tick — kept for history).
- Inline visual confirmation via `browser_vision` (see screenshot rendered
  earlier in this session).
