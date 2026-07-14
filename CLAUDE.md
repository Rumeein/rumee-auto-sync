# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension (no build step, no npm/bundler — plain JS loaded directly by `manifest.json`) that logs into Flipkart Seller Hub and Meesho Supplier Panel on a daily schedule, downloads ~22 report types, and uploads them straight to Google Drive folders that a separate pipeline/dashboard reads from. Read `README.md` for one-time setup (OAuth client, Drive folder permissions, icons) and `DOCS.md` for the full reference (25 sections — job-by-job report details, glossary, known issues). This file only covers what's needed to be productive editing the code; don't duplicate DOCS.md here.

## Commands

There is no build/lint/test pipeline in the npm sense — this is unpacked JS loaded by Chrome.

- **Syntax-check a file before considering an edit done:** `node --check background.js` (or any touched `.js` file). This is the only "compile" step that exists.
- **Run the pure-logic test suites** (plain Node scripts, no framework — `assert`-style, executed top to bottom):
  - `node gap-catchup.test.js` — 21 simulated scenarios for the gap self-healing decision logic
  - `node report-confirm-fallback.test.js` — 11 scenarios for the FK submit-confirmation fallback
- **Reload the extension after any change:** manual only — `chrome://extensions` → find "Rumee — Auto Sync" → click Reload. Browser automation (including Claude's own browser tools) cannot attach to `chrome://` or `chrome-extension://` pages at all, so this step can never be scripted; always ask the user to click it.
- **Trigger a job / read logs without waiting for the daily alarm** — from a live `supplier.meesho.com` tab (the MCP debug relay only exists in `content/meesho.js`, not `content/flipkart.js`, even when the job itself is Flipkart-side):
  ```javascript
  window.postMessage({__rumee:true, msg:{type:'RUN_NOW', jobIds:['fk_views']}}, '*')   // run one or more jobs
  window.postMessage({__rumee:true, msg:{type:'VERIFY_NOW'}}, '*')                     // re-run manifest verification + Discord post
  window.postMessage({__rumee:true, msg:{type:'READ_LOG'}}, '*')                       // → window.__rumeeLog populated, 'rumeeLogReady' event fires
  window.postMessage({__rumee:true, msg:{type:'READ_STATUS'}}, '*')                    // → window.__rumeeStatus populated
  ```
  Standalone tool pages (`*-backfill.html`, `test-*.html`, `fk-api-test.html`, `log.html`) are also `chrome-extension://` pages — same automation restriction, need a manual click to run.

## Architecture

### Job model — `config.js` is the single source of truth

Every report is one entry in the `JOBS` array: `{id, platform, label, startUrl, folderKey, filename, mimeType, frequency}`. `frequency` is `'daily'`, `'3day'`, or `'manual'` (never auto-queued). `DRIVE_FOLDERS` maps `folderKey` → Drive folder ID. **To add a new report, only touch this file plus a handler in the matching content script** — see DOCS.md Section 19 for the exact steps. Never hardcode a Rumee-specific ID/URL/webhook directly in product code; it belongs in `config.js` or the gitignored `secrets.js`, referenced by variable — this repo is meant to be forkable per-tenant (one Drive-folder-set per tenant, not shared multi-tenant routing).

### End-to-end flow (background.js orchestrates, content scripts execute)

`startSync()` builds a queue from `JOBS` filtered by frequency/`lastRun` → `processNextJob()` opens an inactive background tab at the job's `startUrl` → the content script (`content/meesho.js` or `content/flipkart.js`) sends `CONTENT_READY`, gets the job definition back, drives the portal UI, and captures the download → `DOWNLOAD_URL_CAPTURED` (or a direct in-content-script fetch) hands the file to background → uploaded to Drive → `markJobResult()` records success/failure → next job. All state (`syncQueue`, `syncDone`, `syncFailed`, `currentJobId`, `lastRun`, etc.) lives in `chrome.storage.local`, not in memory — the MV3 service worker can be killed mid-job at any time and resumes from storage on next wake. See DOCS.md Section 5 for the full phase-by-phase trace.

### Two-phase Flipkart Reports Centre jobs

`fk_orders`, `fk_payments`, `fk_returns` (and their download counterparts `fk_rc_download`, `fk_returns_download`) split into a request phase and a separate later download/poll phase, because Flipkart generates these reports asynchronously. `fk_listings` and `fk_views`/`fk_views_request` follow the same request→download split. When touching date-picker logic for any of these, note the shared `isFkCalendarDayDisabled()` helper (content/flipkart.js) — Flipkart's calendar sometimes renders a day cell with `pointer-events:none` (looks clickable, isn't) when that report period isn't available yet; this is checked before every calendar click across all three jobs, not just one.

### Download capture — two mechanisms, know which one a handler uses

1. **fetch/XHR monkey-patch** (`content/intercept.js`, MAIN world) — for downloads triggered by a real `fetch`/`XHR` call. Content script arms it, background re-fetches with `credentials:'include'`.
2. **`RELAY_ARM`** (`chrome.downloads.onCreated` in background.js) — for downloads triggered via `window.open()`/native navigation, which mechanism 1 structurally cannot see. Required because Chrome's popup blocker silently kills a `window.open()` fired from a synthetic `.click()` unless the target origin is on Chrome's popup-allow list (`seller.flipkart.com` and `supplier.meesho.com` both need this exception added once per Chrome profile — see DOCS.md Section 18/11 for the full incident).

Never assume a new report's download button uses mechanism 1 — check whether the button is a real anchor/fetch or a `window.open()` call before wiring capture.

### Gap self-healing (`gap-catchup.js`)

Pure decision logic, zero `chrome.*`/DOM calls, fully unit-testable (see Commands above). Tracks jobs that started but didn't finish (order placed on FK but never became ready; a single-shot download that failed) and retries the specific missed **data date** (never the run date — a failure on day X's run always means day X-1's data is owed) on the next run, before that day's own normal job. Escalates to a Discord + Chrome-notification "Manual Action Needed" popup entry after `GAP_CATCHUP_MAX_DAYS` (3) days. Gated by `chrome.storage.local.gapCatchupEnabled` + `gapCatchupJobs` allowlist — clearing that array is the instant kill switch, no code revert needed. Not every job is covered; DOCS.md Section 24 lists exclusions and why (e.g. `fk_returns` download phase can't reliably match a pending request to a specific date, so it escalates immediately instead of guessing).

### Download Manifest — file-level verification (`verifyAndLogManifest()`, background.js)

Answers "is the real file actually in Drive?" per job per day, independent of whether the job logged "success" (a job can succeed and still not produce a usable file). Writes to a native Google Sheet (`DOWNLOAD_MANIFEST_SHEET_ID` in config.js) via `drive/sheets.js` — deliberately not a CSV, because a CSV gets silently reformatted the moment any spreadsheet app opens+saves it (this happened once; see DOCS.md Section 25). `MANIFEST_SLOTS` (background.js) is the list of 22 checked slots, keyed by `folderKey`; multiple job ids can share one `folderKey` (the two-phase pairs above), so slot→job-id mapping is derived at runtime by grouping `JOBS` by `folderKey`, never hardcoded a second time. The daily Discord summary posted from this function lists **only missing files**, each with a real failure reason when one exists in `syncFailed` for that slot's job id(s) — never a fabricated reason when a job simply hasn't run yet or self-skipped by design (e.g. an ads job finding 0 live campaigns that day).

### Secrets

`secrets.js` (gitignored) holds `DISCORD_WEBHOOKS` and `FLIPKART_API_SECRET`; `secrets.example.js` is the committed placeholder template. Loaded via `importScripts` in background.js and as a web-accessible resource for content scripts/standalone tool pages. Never commit real values — copy `secrets.example.js` → `secrets.js` on a new machine.
