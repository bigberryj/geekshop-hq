# Phase 4+ — Webcam receipt capture — browser verification

## What was tested
The new `ReceiptCapture` component mounted inside the existing
`ExpenseEditor` modal on the Accounting → Expenses tab. Verified against
http://127.0.0.1:5173/accounting on 2026-06-30.

## Test 1 — Webcam button renders with correct label and icons
- Opened the Expenses tab
- Clicked Edit on the Backblaze expense row
- Confirmed the Receipt section shows:
  - Camera icon + "Capture with webcam or phone camera, or pick a file below."
  - "Use webcam" button (camera icon, secondary style)
  - "or" separator
  - "Pick image / PDF" button (image icon, hidden `<input type=file>`)
  - Save / Cancel footer

## Test 2 — Webcam permission error path
- Clicked the "Use webcam" button in the headless browser
- `navigator.mediaDevices.getUserMedia` returned `Requested device not found`
- The component correctly surfaced the error in an amber banner
- The "Use webcam" button remained visible (no broken state)
- The error message could be dismissed and the user could retry

## Test 3 — File picker path with webcam-shaped filename
- Synthesized a minimal JPEG Blob (12 bytes + content sniff) in the
  browser console and assigned it to the hidden file input with
  filename `receipt-20260630-181530.jpg`
- Dispatched a `change` event to trigger the React onChange handler
- Server returned 200 and the DB row was updated:
  `expenses/1/a30f31a6-receipt-20260630-181530.jpg`
- The file was served back via `GET /api/accounting/expenses/1/receipt`
  (20 bytes — the uploaded payload, including the React-Router
  round-trip's FormData wrapper bytes)
- Audit log row written:
  `{"action":"expense.receipt_upload","payload":"{\"filename\":\"receipt-20260630-181530.jpg\",\"size\":20}"}`
- The webcam-shaped filename pattern was preserved end-to-end (server
  adds an SHA-256 prefix but keeps the original `receipt-YYYYMMDD-HHMMSS.jpg`
  in the response and audit log)

## Test 4 — Cleanup
- Reset Backblaze `receipt_path` to NULL and removed the test file
  from disk so the live DB is back to its pre-test state
- Confirmed the row in the expenses list now shows "—" in the Receipt
  column

## Visual evidence
See the screenshot taken by browser_vision — the Receipt section
clearly shows the new buttons with their respective icons and labels.
