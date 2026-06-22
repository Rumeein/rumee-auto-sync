# Rumee Extension — Complete Project Documentation

> **Who this document is for:** Any developer, analyst, or AI assistant who needs to understand, maintain, extend, or debug this project. You should be able to understand the entire system from this file alone — without asking the business owner a single question.
>
> **Companion file:** `recording.md` contains step-by-step UI navigation screenshots and notes captured during the recording sessions. Read that file if you need the exact click-by-click flow for a specific report.

---

## Table of Contents

1. [Business Context](#1-business-context)
2. [What This Extension Does](#2-what-this-extension-does)
3. [Technical Architecture](#3-technical-architecture)
4. [Extension File Structure](#4-extension-file-structure)
5. [How a Job Runs — End to End](#5-how-a-job-runs--end-to-end)
6. [Secrets Management](#6-secrets-management)
7. [Configuration Reference (config.js)](#7-configuration-reference-configjs)
8. [Meesho Reports — Detailed Reference](#8-meesho-reports--detailed-reference)
9. [Flipkart Reports — Detailed Reference](#9-flipkart-reports--detailed-reference)
10. [Google Drive Folder Structure](#10-google-drive-folder-structure)
11. [Download Mechanisms](#11-download-mechanisms)
12. [Bot Detection & Human-like Behavior](#12-bot-detection--human-like-behavior)
13. [Session Recovery](#13-session-recovery)
14. [Installation & Setup Guide](#14-installation--setup-guide)
15. [Flipkart Scheduled Reports Setup](#15-flipkart-scheduled-reports-setup)
16. [Operating the Extension (Daily Use)](#16-operating-the-extension-daily-use)
17. [What the Pipeline Receives](#17-what-the-pipeline-receives)
18. [Known Issues & Pending Actions](#18-known-issues--pending-actions)
19. [How to Add a New Report](#19-how-to-add-a-new-report)
20. [Multi-Account & Multi-Business Use](#20-multi-account--multi-business-use)
21. [Chrome Web Store Publishing (Future Reference)](#21-chrome-web-store-publishing-future-reference)
22. [Glossary](#22-glossary)
23. [Flipkart UI Internals & Timing Behavior](#23-flipkart-ui-internals--timing-behavior)

---

## 1. Business Context

### Who is Rumee Jewellery?

Rumee Jewellery (`rumeein@gmail.com`) is an artificial jewellery brand that sells on two Indian e-commerce marketplaces:

| Marketplace | Seller Portal URL | Account Name | Notes |
|---|---|---|---|
| **Flipkart** | seller.flipkart.com | RumeeJewellery | Also sells on Shopsy (Flipkart-owned platform, same portal) |
| **Meesho** | supplier.meesho.com | Supplier slug: `xuptj` | Slug appears in all portal URLs after login |

Products are primarily earrings and jewellery sets. Currently ~87 active listings on Flipkart, growing catalog on Meesho.

### Why This Extension Exists

Both portals generate dozens of reports every day — orders, payments, returns, ad spend, inventory levels, traffic, keywords. These reports are essential for:

| Business Need | Reports Used |
|---|---|
| **Daily P&L per order** | Orders + Payments + Returns + SPF Claims |
| **Inventory management** | Catalog/Inventory + Orders |
| **Ad ROI tracking** | Ads Daily + FSN + Orders attributed to ads |
| **Return loss calculation** | Returns + SPF Claims + Payments |
| **Organic traffic optimization** | Views + Keywords |
| **Accounting & reconciliation** | Payments + Tax sheets |

**Before this extension existed**, everything was downloaded manually — the business owner would log into each portal, navigate to each report section, click through date pickers, wait for files to generate, download them, and then manually compile multiple files into single Excel workbooks. This took significant time every day and was error-prone.

**This extension automates the entire download process** and uploads files directly to organized Google Drive folders, from where a data pipeline picks them up for processing.

### What the Extension Does NOT Do

- It does **not** process, transform, or analyze the data — that is the pipeline's job
- It does **not** require any AI or LLM to run — every decision is hardcoded
- It does **not** store any credentials — it uses the browser's existing login sessions
- It does **not** push to any external servers except Google Drive (via OAuth2)

---

## 2. What This Extension Does

Every day at a scheduled time (default 09:00, configurable), the extension:

1. Checks which jobs are due to run today (based on frequency and last run date)
2. For each due job, opens a background browser tab to the relevant portal
3. The tab navigates the portal UI automatically (clicks, waits, fills date pickers)
4. Intercepts the download URL when the file is ready
5. Fetches the file from the background (with session cookies) to bypass browser download dialogs
6. Uploads the file directly to the correct Google Drive folder
7. Marks the job as done and moves to the next one
8. Sends a Chrome notification when all jobs are complete (or if any failed)

The user can also manually trigger any individual job from the extension popup at any time.

---

## 3. Technical Architecture

### Technology Stack

| Component | Technology | Why |
|---|---|---|
| Extension type | Chrome Extension MV3 | Modern standard; service workers for background |
| Background | Service Worker (background.js) | Sleeps between jobs — saves memory; survives browser restart |
| Content scripts | Plain JavaScript | Runs inside portal pages; has full DOM access |
| State storage | `chrome.storage.local` | Persists across service worker sleep/wake cycles |
| Authentication | Chrome Identity API (OAuth2) | Secure Google login without storing credentials |
| File upload | Google Drive API v3 | Direct upload to specific folders |
| Portal interaction | DOM manipulation + fetch interception | Human-like UI automation |

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Chrome Extension (MV3)                          │
│                                                                      │
│  ┌──────────────────┐       messages        ┌──────────────────┐   │
│  │  background.js   │◄─────────────────────►│  content scripts │   │
│  │                  │                        │                  │   │
│  │  • Job queue     │  CONTENT_READY →       │  meesho.js       │   │
│  │  • Alarm mgmt    │  ← job definition      │  flipkart.js     │   │
│  │  • Tab lifecycle │                        │                  │   │
│  │  • Drive upload  │  DOWNLOAD_URL_CAPT. →  │  • Navigate UI   │   │
│  │  • Popup msgs    │  JOB_ERROR →           │  • Click buttons │   │
│  └──────────────────┘                        │  • Intercept DL  │   │
│          │                  │                └──────────────────┘   │
│          │            config.js                                      │
│          │         (shared by both)                                  │
│          │                                                           │
│  ┌───────┴──────────┐                                               │
│  │  drive/upload.js │                                               │
│  │                  │                                               │
│  │  • OAuth2 token  │                                               │
│  │  • Multipart     │                                               │
│  │    upload        │                                               │
│  │  • File upsert   │                                               │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                        │
         ▼                    ▼                        ▼
   Chrome alarms        supplier.meesho.com      Google Drive API
   (daily trigger)      seller.flipkart.com      (googleapis.com)
```

### Message Types (content script ↔ background)

| Message | Direction | Payload | Meaning |
|---|---|---|---|
| `CONTENT_READY` | content → background | `{}` | Page loaded, content script ready. Background replies with job definition |
| `DOWNLOAD_URL_CAPTURED` | content → background | `{jobId, url, headers, referer, filename, folderKey, mimeType}` | File URL intercepted. Background fetches and uploads |
| `JOB_ERROR` | content → background | `{jobId, error}` | Unrecoverable error. Background marks job failed and moves on |
| `RUN_NOW` | popup → background | `{jobIds: [...] or null}` | User clicked "Run Now" in popup |
| `GET_STATUS` | popup → background | `{}` | Popup requesting current sync status |
| `UPDATE_SCHEDULE` | popup → background | `{hour, minute}` | User changed daily schedule time |

### State in `chrome.storage.local`

The service worker can be killed by Chrome at any time. All state lives in storage:

| Key | Type | Meaning |
|---|---|---|
| `syncRunning` | boolean | Whether a sync is currently in progress |
| `syncQueue` | string[] | Job IDs waiting to be processed |
| `syncDone` | string[] | Job IDs completed this sync run |
| `syncFailed` | `{id, error}[]` | Failed jobs this sync run |
| `syncStarted` | number | Timestamp when current sync started (for stale detection — resets after 90 min) |
| `currentJobId` | string | Job currently being processed |
| `currentTabId` | number | Browser tab currently open for the active job |
| `lastRun` | `{[jobId]: 'YYYY-MM-DD'}` | Last successful download date per job (used for incremental date ranges) |
| `scheduleHour` | number | Hour for daily alarm (default: 9) |
| `scheduleMinute` | number | Minute for daily alarm (default: 0) |
| `needsSetup` | boolean | `true` on fresh install — shows setup screen in popup instead of main UI |
| `customFolders` | object | Active Drive folder IDs (same shape as DRIVE_FOLDERS). Set by setup wizard or migration. Overrides hardcoded defaults. |

---

## 4. Extension File Structure

```
rumee-extension/
│
├── manifest.json          Chrome Extension manifest v3
│                          Declares permissions, content scripts, OAuth config
│
├── secrets.js             ⭐ GITIGNORED — local machine only
│                          All secrets: DISCORD_WEBHOOKS, FLIPKART_API_SECRET
│                          Loaded first in background.js (importScripts) and
│                          fk-api-test.html. Never commit this file.
│                          Copy from secrets.example.js to create on a new machine.
│
├── secrets.example.js     Template with placeholder values — committed to git
│
├── config.js              ⭐ THE MOST IMPORTANT FILE
│                          Single source of truth for ALL job definitions and
│                          Drive folder IDs. Edit ONLY this file to add/remove
│                          reports or change folder IDs.
│
├── background.js          Service worker — runs in background, never visible
│                          Manages job queue, alarm scheduling, Drive uploads,
│                          tab lifecycle, popup communication
│
├── drive/
│   └── upload.js          Google Drive upload module
│                          Handles OAuth2 token acquisition via Chrome Identity
│                          API, constructs multipart upload requests, upserts
│                          files (update if exists, create if not)
│
├── content/
│   ├── meesho.js          Content script injected into supplier.meesho.com
│                          Handles all 7 Meesho report downloads
│   └── flipkart.js        Content script injected into seller.flipkart.com
│                          Handles all 14+ Flipkart report downloads
│
├── popup.html             Extension popup (shown when clicking the extension icon)
│                          Shows: current sync status, last run times per job,
│                          Run Now button, schedule configuration
│
├── icons/
│   ├── icon16.png         ⚠️ MISSING — 16×16 px PNG (required by manifest)
│   ├── icon48.png         ⚠️ MISSING — 48×48 px PNG (required by manifest)
│   └── icon128.png        ⚠️ MISSING — 128×128 px PNG (required by manifest)
│                          Extension will not load without these files
│
├── DOCS.md                ← This file
└── recording.md           Step-by-step UI recording notes (developer reference)
                           Contains exact click paths, screenshots analysis,
                           and questions answered during discovery sessions
```

---

## 5. How a Job Runs — End to End

### Phase 1: Scheduling

The extension creates a Chrome alarm that fires daily at 09:00 (configurable). When the alarm fires, `startSync()` is called in `background.js`.

```
startSync()
  → read lastRun from storage
  → for each job in JOBS:
      if frequency='daily' AND lastRun[id] != today → include
      if frequency='3day' AND daysSince(lastRun[id]) >= 3 → include
      if frequency='manual' → never auto-include
  → store queue in chrome.storage.local
  → call processNextJob()
```

### Phase 2: Opening a Tab

```
processNextJob()
  → pop first job from queue
  → store currentJobId
  → close any stale tab from previous run
  → chrome.tabs.create({ url: job.startUrl, active: false })
  → store currentTabId
  → wait for content script to send CONTENT_READY
```

The tab opens in the background (user doesn't see it switch). `active: false` means the user's current tab is not disturbed.

### Phase 3: Content Script Runs

When the tab finishes loading, the content script fires:

```javascript
// Content script startup (both meesho.js and flipkart.js)
const job = await chrome.runtime.sendMessage({ type: 'CONTENT_READY' });
if (!job) return; // not our tab, ignore

// Meesho: navigate to correct section via sidebar
// Flipkart: navigate to correct section
// Wait for page to be ready
// Set up download interception
// Click buttons, fill date pickers
// Capture download URL
// Send DOWNLOAD_URL_CAPTURED to background
```

### Phase 4: Background Fetches and Uploads

```
handleDownloadUrlCaptured()
  → fetch(url, { credentials: 'include', headers: { Referer, ...captured headers } })
  → uploadToDrive(buffer, filename, folderId, mimeType)
  → markJobResult(jobId, success=true)
  → record lastRun[jobId] = today
  → close tab
  → setTimeout(processNextJob, JOB_GAP_MS)  // 4 second gap between jobs
```

The background fetches the file with `credentials: 'include'` which automatically includes the portal's session cookies (the extension has `host_permissions` for both domains). This is why the user must be logged into both portals before running the extension.

### Phase 5: Job Complete

After all jobs finish, `finishSync()` is called:
- `syncRunning` set to `false`
- Chrome notification sent: "✅ All N files synced to Drive" or error summary

### Resume After Sleep

If Chrome kills the service worker mid-job (this happens after ~30 seconds of inactivity), the IIFE at the bottom of `background.js` detects this on next wake-up:

```javascript
// On every service worker startup:
if (syncRunning) {
  if (currentJobId && not in syncQueue) {
    re-queue currentJobId at front  // resume interrupted job
  }
  processNextJob()  // continue
}
```

---

## 6. Secrets Management

All secrets live in `secrets.js` — gitignored, never committed, exists only on the local machine.

### File: `secrets.js` (gitignored — local only)

```javascript
const DISCORD_WEBHOOKS = {
  AUTO_SYNC: 'https://discord.com/api/webhooks/...',  // #auto-sync channel
};

const FLIPKART_API_SECRET = '12b66c...';  // Flipkart Seller API secret
```

### File: `secrets.example.js` (committed — placeholder values only)

Template. Copy to `secrets.js` on a new machine and fill in real values.

### How secrets are loaded

| Consumer | How |
|---|---|
| `background.js` | `importScripts('secrets.js', 'config.js', ...)` — loaded first, available globally |
| `fk-api-test.html` | `<script src="secrets.js">` before `fk-api-test.js` — secret field auto-populated |
| Content scripts (meesho.js, flipkart.js) | Do NOT use secrets — they only use DRIVE_FOLDERS and JOBS from config.js |

### What each secret is for

| Secret | Purpose |
|---|---|
| `DISCORD_WEBHOOKS.AUTO_SYNC` | Posts sync completion summary to Rumee Discord #auto-sync channel |
| `FLIPKART_API_SECRET` | Flipkart Seller API authentication — used in fk-api-test tool and future direct API calls |

### Setting up on a new machine

```
1. Copy secrets.example.js → secrets.js
2. Fill in real values (get from Jaiswal or password manager)
3. Reload extension in chrome://extensions
4. Never commit secrets.js
```

### Why this pattern exists

Before June 2026, `DISCORD_WEBHOOKS` was hardcoded in `config.js` and committed to the public GitHub repo. GitGuardian flagged the webhook URL twice. After the second incident, secrets were moved to this gitignored file permanently.

---

## 7. Configuration Reference (config.js)

`config.js` is loaded by both `background.js` (via `importScripts`) and content scripts (via manifest `js` array). **Any change to jobs or folder IDs must be made only in this file.**

### DRIVE_FOLDERS object

```javascript
const DRIVE_FOLDERS = {
  FOLDER_KEY: 'google-drive-folder-id',
  // ...
};
```

Folder IDs are the long strings in Google Drive URLs: `drive.google.com/drive/folders/THIS_PART`.

### JOBS array

Each job object has these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | ✅ | Unique job identifier. Used as key in `lastRun` storage. Snake_case. |
| `platform` | `'meesho'` \| `'flipkart'` | ✅ | Which portal. Content script uses this to decide what to do. |
| `label` | string | ✅ | Human-readable name shown in popup and notifications. |
| `startUrl` | string | ✅ | URL the background opens in a new tab. Content script fires when this page loads. |
| `folderKey` | string | ✅ | Key into `DRIVE_FOLDERS`. Determines which Drive folder the file uploads to. |
| `filename` | string | ✅ | Base filename for the uploaded file. Date may be appended by content script. |
| `mimeType` | string | ✅ | MIME type for the Drive upload. |
| `frequency` | `'daily'` \| `'3day'` \| `'manual'` | ✅ | How often this job auto-runs. |
| `reportType` | string | ❌ | For FK Reports Centre jobs: the Type filter value (e.g. `'Fulfilment Reports'`). |
| `reportSubType` | string | ❌ | For FK Reports Centre jobs: the Sub Type to match (e.g. `'orders'`). |
| `adsReportType` | string | ❌ | For FK Ads jobs: the dropdown value (e.g. `'Consolidated Daily Report'`). |

### Timing Constants

| Constant | Default | Meaning |
|---|---|---|
| `TIMEOUT_MS` | 30000 | Milliseconds to wait for a page element or download URL before declaring failure |
| `JOB_GAP_MS` | 4000 | Milliseconds to wait between jobs (lets tabs settle and avoids rate limiting) |

---

## 8. Meesho Reports — Detailed Reference

### Overview of Meesho Navigation Pattern

All Meesho jobs use **human-like navigation**:
- Start at `https://supplier.meesho.com/` (dashboard home)
- Navigate to the target section by clicking the left sidebar — same as a human would
- The sidebar is always visible and accessible from any page
- This avoids jumping to deep URLs which could trigger bot detection

The content script extracts the supplier slug (`xuptj`) dynamically from the current URL using:
```javascript
const m = window.location.href.match(/supplier\.meesho\.com\/panel\/v\d+\/new\/[^/]+\/([^/?#]+)/);
const slug = m ? m[1] : 'xuptj'; // fallback to known slug
```

---

### ME_ORDERS — Meesho Orders CSV

**Drive folder key:** `ME_ORDERS`  
**Drive folder ID:** `1V0ZnC6r577zYJIYeyDhl8rItBrAXgnwQ`  
**Frequency:** Daily  
**File format:** CSV  
**Download type:** Async export (request → wait → refresh → download)

**What it contains:**  
Every order placed by a customer on Meesho. Includes the full lifecycle: order placed, shipped, delivered, returned, cancelled. Each row is one order item.

**Key columns:**
- Sub Order No — unique order item ID
- Order Date, Delivery Date
- Order Status (delivered, cancelled, returned, etc.)
- SKU, Product Name, Quantity
- Selling Price, Shipping Charges
- Payment Method (prepaid/COD)
- Customer City, State
- Return Date, Return Reason, AWB Number (if returned)

**Why this report matters:**  
This is the foundation of all revenue tracking. Every rupee earned starts here. Used with ME_PAYMENTS to verify settlement amounts and with ME_RETURNS to reconcile return quantities.

**Portal navigation:**
1. Land on dashboard → wait for sidebar to load
2. Click "Orders" in left sidebar
3. Click "Download Orders Data ∧" button (top-right of orders page) → dropdown opens
4. Click "Select Date Range" → modal opens with dual calendar (max 1 month range)
5. Click From date → click To date → click "Export data"
6. Modal closes, export is queued — file NOT immediately ready
7. Refresh the page (F5)
8. Click "Download Orders Data ∧" again → check "EXPORTED FILES" section
9. Find file matching today's export (most recent at top) → click "Download ↓"
10. Intercept download URL → fetch → upload to Drive

**Date range logic:**
- From = `lastRun['me_orders']` + 1 day
- To = today
- If gap > 30 days: split into multiple ≤30-day requests (portal enforces 1-month max)
- First ever run: start from earliest date available (approx. when seller joined Meesho)

**File identification:**  
The "EXPORTED FILES" list shows files with date labels. Match by the date label corresponding to the export just triggered, or take the topmost entry if it was just generated.

---

### ME_RETURNS — Meesho Returns CSV

**Drive folder key:** `ME_RETURNS`  
**Drive folder ID:** `1MEW8yK9lsercJ5k1gQIRh_xiOHpneSV8`  
**Frequency:** Daily  
**File format:** CSV  
**Download type:** Async export (near-instant, identified by timestamp)

**What it contains:**  
All return shipments — both RTO (package refused/undelivered, sent back) and customer-initiated returns. Covers the last 2 weeks (portal constraint — cannot select custom range).

**Key columns:**
- AWB Number — unique tracking ID for the shipment (use for deduplication)
- Return Type (RTO / Customer Return)
- Return Status
- Return Date
- SKU, Product Name, Quantity
- Return Reason, Return Sub-Reason

**Why this report matters:**  
Every return is a cost event — return shipping, potential product damage, operational time. This report feeds directly into loss calculation per order. Combined with SPF claims (ME_CLAIMS) to calculate how much was recovered.

**Portal navigation:**
1. Click "Returns" in left sidebar
2. Click "Overview" tab (if not already there)
3. Click "Return Tracking" sub-tab
4. Click "Delivered" filter (shows completed returns, not in-transit)
5. Click the "0/0 files ready" button → small panel opens
6. Click "Export"
7. New file appears almost instantly — identified by its timestamp (most recent)
8. Click "Download ↓" → intercept → upload

**Duplicate handling:**  
Always downloads last 2 weeks regardless of `lastRun`. Pipeline deduplicates by AWB Number. Overlapping data is expected and handled.

---

### ME_PAYMENTS — Meesho Payments XLSX (inside ZIP)

**Drive folder key:** `ME_PAYMENTS`  
**Drive folder ID:** `1DoZoUTmNf6hMqC0-WlS2IWPzTDwyAwQr`  
**Frequency:** Daily  
**File format:** ZIP (upload as-is; contains one XLSX)  
**Download type:** Direct browser download (no async wait)

**What it contains:**  
Settlement details for every order that was paid out during the selected date range. A payment settlement on Meesho happens when an order is completed (delivered and return window passed) and Meesho transfers money to the seller's bank account.

**The XLSX inside the ZIP contains:**
- Settlement date and NEFT reference
- Per-order breakdown: selling price, Meesho commission, shipping fee, return deductions, net payout
- Tax details (GST, TDS)

**Why this report matters:**  
This confirms what was actually paid vs. what was expected. Critical for accounting and detecting discrepancies between what Meesho shows in the app vs. what lands in the bank account.

**Portal navigation:**
1. Click "Payments" in left sidebar
2. Click "Download ∨" dropdown button → panel appears
3. Click "Payments to Date" option
4. Select "Custom Date Range"
5. Use calendar picker: select From and To dates
6. Click "Download" → ZIP file downloads directly (no async wait, no refresh needed)
7. Intercept download → upload ZIP to Drive as-is

**Pipeline note:**  
Upload the ZIP file directly. The pipeline extracts the XLSX inside. Do not unzip in the extension — simpler and more reliable.

---

### ME_ADS — Meesho Ads Cost XLSX

**Drive folder key:** `ME_ADS`  
**Drive folder ID:** `1HMThJGvTIVygdjKh1pTyzbEblro4_0sk`  
**⚠️ Drive folder permissions need fixing — canAddChildren: false**  
**Frequency:** Daily  
**File format:** XLSX  
**Download type:** Direct API call (no download button exists on portal)

**What it contains:**  
Daily ad campaign performance — spend, impressions, clicks, ROAS (Return on Ad Spend), orders attributed to ads. Campaign-level and daily-level granularity.

**Why this report matters:**  
Ad spend is the largest variable cost for most Meesho sellers. This report tells you what you spent on ads, which campaigns performed, and what you got in return. Combined with ME_ORDERS, it shows ad-attributed vs. organic orders.

**Why direct API (not UI download):**  
Meesho's ads section does not have a download button for campaign reports. The data is loaded via internal API calls when you view the ads dashboard. The extension intercepts these API calls to capture the required headers (especially `browser-id`, a session-specific Base64 value), then makes direct API calls to retrieve the data.

**Technical approach:**
1. Navigate to Ads section
2. Inject a JavaScript interceptor that patches `window.fetch` and `XMLHttpRequest.prototype.open`
3. Trigger a fresh API call by clicking the "Yesterday" button on the Ads page
4. Interceptor captures: exact API URL, request headers (including `browser-id`), response JSON
5. Use captured headers to make additional API calls for campaign + daily data
6. Build XLSX from response data
7. Upload to Drive

**Critical header — `browser-id`:**  
This header is a Base64-encoded value that Meesho generates per session. It changes each login. The extension must capture it at runtime from the page's own XHR calls rather than hardcoding it. If this header is missing or wrong, Meesho returns "Bad Request: Invalid client type."

---

### ME_CLAIMS — Meesho Support Tickets CSV

**Drive folder key:** `ME_CLAIMS`  
**Drive folder ID:** `1LX79E16fhxEF5kZGWmdXl4oNsVvqwspf`  
**⚠️ Drive folder permissions need fixing — canAddChildren: false**  
**Frequency:** Daily  
**File format:** CSV  
**Download type:** Async export (identified by timestamp)

**What it contains:**  
All support tickets raised with Meesho — wrong returns received, damaged products, logistics issues, billing disputes. Each ticket has a status (open, resolved, closed).

**Why this report matters:**  
Tracks which issues were raised, which were resolved in the seller's favour, and which payments/credits were received as resolution.

**Portal navigation:**
1. Click "Claims" in left sidebar
2. Set date filter to "Last 30 Days" (first run: "Last 180 Days")
3. Click "Download ∨" dropdown → "Export"
4. New file appears — identified by timestamp (most recent in list)
5. Click "Download ↓" → intercept → upload

**Date range logic:**
- First run: download last 180 days of history
- Subsequent runs: always "Last 30 Days" (overlapping is fine — deduplicate by ticket ID)

**Session recovery note:**  
Meesho sessions expire while navigating. If redirected to login mid-job:
1. Click the email input field (Chrome autofill fills credentials)
2. Click the Login button
3. Continue from where the job left off
One attempt only. If still on login page after, mark job FAILED and notify user.

---

### ME_CATALOG — Meesho Inventory XLSX

**Drive folder key:** `ME_CATALOG`  
**Drive folder ID:** `1e7qdkFu6trp3BQDQdAY22i_INGvzKNeu`  
**Frequency:** Daily  
**File format:** XLSX  
**Download type:** Direct browser download (no async wait)

**What it contains:**  
A complete snapshot of all catalog items and their current stock levels — both the stock level Meesho's system shows and the stock level the seller has declared.

**Confirmed columns:**
```
SERIAL NO | CATALOG NAME | CATALOG ID | PRODUCT NAME | PRODUCT ID |
STYLE ID | VARIATION ID | VARIATION | STOCK | SYSTEM STOCK COUNT | YOUR STOCK COUNT
```

**Why this report matters:**  
- Track daily stock changes — when stock drops it shows which products are selling
- Detect discrepancies between "YOUR STOCK COUNT" (what you told Meesho) and "SYSTEM STOCK COUNT" (what Meesho records)
- Identify catalog items that need restocking

**Important note — this is a workaround:**  
Meesho does not have a dedicated inventory/catalog export feature. The "Bulk Stock Update" template download is the only way to get all catalog data in bulk. The template is designed for bulk stock uploads, but it contains all the catalog data we need.

**Portal navigation:**
1. Click "Inventory" in left sidebar
2. Click "Bulk Stock Update" option
3. In the popup, click "Step 1: Download" button
4. File generates immediately — browser download dialog appears
5. Intercept download → upload to Drive

---

### ME_VIEWS — Meesho Dashboard Views CSV

**Drive folder key:** `ME_VIEWS`  
**Drive folder ID:** `1EMqTpDtsratSY66UbbrV4VsnGIXYKFqV`  
**Frequency:** Daily  
**File format:** CSV (generated in-memory by extension — no download button)  
**Download type:** DOM scrape of dashboard stats

**What it contains:**  
Daily views and orders counts as shown on the Meesho supplier dashboard home page.

**Output format:**
```csv
Date,Views,Orders
2026-05-28,9200,12
2026-05-27,8700,9
```

**Why this report matters:**  
Organic impressions data. Meesho does not provide a downloadable views report (without a paid premium subscription). The dashboard home page shows views and orders for recent dates — the extension scrapes this before navigating away to other sections.

**How it works:**  
The dashboard shows a summary like "Views: 9.2K" and "Orders: 12" with a date label. The content script reads these values from the DOM and appends them to a running CSV file in Drive. Data typically lags 1-2 days.

**Important:**  
Read the date from the page label — do not assume it is today's date. The data shown is always for the last complete day, not the current day.

---

## 9. Flipkart Reports — Detailed Reference

### Overview of Flipkart Navigation

Flipkart's seller portal is a single-page application (SPA). Reports are spread across 4 different sections:

| Section | Reports found there |
|---|---|
| **Reports Centre** (sidebar → Reports → Reports Centre) | FK_ORDERS, FK_RETURNS, FK_PAYMENTS |
| **Listings section** (sidebar → Listings → My Listings) | FK_LISTINGS |
| **Growth section** (sidebar → Growth → Nxt Insights → Traffic Report) | FK_VIEWS, FK_KEYWORDS |
| **Ads section** (sidebar → Ads → Reports → Other Reports) | All 7 FK_ADS reports |
| **Help Centre** (floating Help button → My Help Centre → My Tickets → SPF Claims) | FK_CLAIMS |

Unlike Meesho, Flipkart does not have aggressive bot detection. Deep-linking to specific URL hashes works fine.

---

### FK_ORDERS, FK_RETURNS, FK_PAYMENTS — Reports Centre (Scheduled)

These three reports are handled identically. They are set up as **daily scheduled reports** in Flipkart's Reports Centre — Flipkart auto-generates them every day, and the extension simply finds and downloads the latest file.

**How scheduled reports work:**  
Once configured (see Section 14), Flipkart generates these reports every day automatically. They appear in the "Requested" tab of the Reports Centre with Status = "Generated". The extension does not need to request them — only download them.

**Navigation (same for all three):**
1. Sidebar → hover over "Reports" → click "Reports Centre"
2. Reports Centre page loads. Verify "Scheduled" tab shows 3 active schedules.
3. Click "Requested" tab (shows history of all generated reports)
4. Apply category filter tab (Fulfilment / Payment) to narrow results
5. Find the row where:
   - Type matches the report category
   - Sub Type matches (e.g., "orders", "returns", "settled transactions")
   - Requested Date = today (or most recent for this job)
   - Status = "Generated"
6. Click "Download ↓" for that row → intercept URL → fetch → upload

**If not yet generated:**  
Wait 2 minutes, refresh, check again. Retry up to 5 times (10 minutes total). If still not ready, mark PENDING and notify user.

---

### FK_ORDERS — Flipkart Orders XLSX

**Drive folder key:** `FK_ORDERS`  
**Drive folder ID:** `1-LzJJo3Wi3x6YrUjYCm7SYm3x2tWQqko`  
**Frequency:** Daily  
**File format:** XLSX  
**Reports Centre:** Fulfilment Reports → Orders

**What it contains:**  
Every order item across the entire lifecycle. Multiple sheets — the "Orders" sheet is primary.

**Key columns:**
- Order Item ID, Order ID
- Fulfilment Type: FBF (Flipkart warehouse) / Non-FBF (seller ships) / Self Ship
- Order Date, Order Approval Date
- Order Item Status (approved / shipped / delivered / cancelled / returned)
- SKU, FSN (Flipkart product ID), Product Title, Quantity
- Dispatch By Date, Delivery By Date (SLA dates)
- RTD / Dispatch SLA Breached (Y/N)
- Delivery SLA Breached (Y/N)
- Return ID, Return Reason, Return Sub-Reason

**Files in Drive already:**  
Named by month: `01_2026.xlsx`, `02_2026.xlsx`, ..., `05_2026.xlsx`  
The pipeline appends daily downloads to monthly files.

---

### FK_RETURNS — Flipkart Returns XLSX

**Drive folder key:** `FK_RETURNS`  
**Drive folder ID:** `PLACEHOLDER` ⚠️ Create folder and update config.js  
**Frequency:** Daily  
**File format:** XLSX  
**Reports Centre:** Fulfilment Reports → Returns

**What it contains:**  
All return shipments — both RTO (logistics returned without delivery) and customer-initiated returns. Each row is one return shipment with full reverse logistics tracking.

**Why separate from FK_ORDERS:**  
FK_ORDERS contains a return record once the return is approved. FK_RETURNS contains the detailed reverse shipment journey — pickup, in-transit, delivered back to seller — which is needed for loss calculation timing.

---

### FK_PAYMENTS — Flipkart Payments XLSX

**Drive folder key:** `FK_PAYMENTS`  
**Drive folder ID:** `1KY-M0_7_FDm_GlqMht4HO2w2wzPRkSgp`  
**Frequency:** Daily  
**File format:** XLSX (multi-sheet)  
**Reports Centre:** Payment Reports → Settled Transactions

**What it contains:**  
All financial settlements. "Settled" means Flipkart has transferred the money to the seller's bank account for these transactions.

**Sheets in the file:**

| Sheet | Contents |
|---|---|
| **Orders** | Per-order settlement: NEFT ID, selling price, marketplace fee, taxes, SPF deductions, net amount |
| **MP Fee Rebate** | Seller incentive rebates — reversals of marketplace fee |
| **Storage & Recall** | Charges for using Flipkart warehouse (FBF storage fees) |
| **Non Order SPF** | Protection fund for inventory lost/damaged in Flipkart's own warehouse |
| **Ads** | Settled ad spend deductions (money taken from seller account for ads run) |
| **Value Added Services** | Optional services purchased (enhanced listing, etc.) |
| **TDS** | Tax Deducted at Source — tax refund claims |
| **Tax Details** | GST breakdown per transaction |
| **TCS Recovery** | Tax Collected at Source recovery |

**Historical note:**  
Transactions before December 2025 are under a different report type called "Financial Reports" in the portal. This daily sync covers December 2025 onwards only.

---

### FK_CLAIMS — Flipkart SPF Claims XLSX

**Drive folder key:** `FK_CLAIMS`  
**Drive folder ID:** `1Ov-iVVqrl9KpCoZXUlqeV0tNTjGFQeD3`  
**⚠️ Drive folder permissions need fixing — canAddChildren: false**  
**Frequency:** Daily  
**File format:** XLSX (2 sheets)  
**⚠️ NOT in Reports Centre — unique navigation path**

**What it contains:**  
Seller Protection Fund (SPF) claims. When a return arrives at the seller and something is wrong — product missing, damaged, completely wrong item — the seller raises an SPF claim. Flipkart reviews it and approves, rejects, or partially approves. This report tracks every claim and its outcome.

**Business context (important):**  
When a customer returns an order to Rumee Jewellery, sometimes the package arrives with:
- The wrong product inside (customer swapped it)
- An empty box (product stolen in transit)
- A damaged product (broken in logistics)
- Nothing at all

In these cases Rumee loses: (a) the original product cost, (b) return shipping paid, (c) the selling price refunded to the customer. An SPF claim recovers a portion of this loss. Without tracking these claims, the true cost of returns cannot be calculated.

**Sheet 1 — Seller Raised Claims:**

| Column | Meaning |
|---|---|
| Claim ID | Unique identifier — use for deduplication |
| Incident ID | Secondary reference number |
| Order ID | The original order this claim relates to |
| Order Item ID | Specific item within the order |
| Created At | When the seller raised the claim |
| Updated At | Last status change |
| Claim Status | Processing / Awaiting Seller Response / Approved / Not Approved / Closed-No Response |
| Approved Amount | ₹ Flipkart will pay — blank if not approved |
| Not Approved Reason | Reason for rejection if applicable |

**Sheet 2 — Auto Approved Claims:**

| Column | Meaning |
|---|---|
| Auto-Claim Reason | FBF Orders / FBF Inventory / Shipment Lost |
| Claim Processing Date | When Flipkart processed it |
| Pay/Recovery | "Pay" = seller receives money · "Recover" = Flipkart claws back |

**Navigation (unique — not through Reports Centre):**
1. From any page → click floating **Help** button (bottom-right corner, always visible)
2. Help pop-up → click **"My Help Centre"** (top of popup)
3. Help Centre page → click **"My Tickets >"** button
4. Tickets Dashboard → two tabs at top: "General Tickets" | **"SPF Claims"**
5. Click **"SPF Claims"** tab
6. Click **"Download Report ∨"** button (top-right of SPF Claims page)
7. Dropdown: Last 3 days / Last 7 days / Last 15 days / Last 30 days / **Custom Date Range**
8. Click **"Custom Date Range"** → calendar picker opens
9. Select From = `lastRun['fk_claims']` + 1 day → select To = today
10. Click "Done" → file downloads immediately (no async wait)
11. Intercept → upload to Drive

**Deep link shortcut to test:**  
`seller.flipkart.com/index.html#claims` — if this navigates directly to the SPF Claims page, skip steps 1–4. Test during implementation.

**Date range for first run:** Download from December 2025 → today (full history).  
**Deduplication:** Always deduplicate by Claim ID in the pipeline. Overlapping ranges are fine.

**Existing data in Drive:** `claim_report till 27 may 26.xlsx` — manual download, Dec 2025 → 27 May 2026.

---

### FK_LISTINGS — Flipkart Master Listing XLS

**Drive folder key:** `FK_LISTINGS`  
**Drive folder ID:** `1sBCegMtxLxr02RkvmlJ5OGYHfD_raBnU`  
**Frequency:** Manual (only when SKU catalog changes)  
**File format:** XLS (legacy format, not XLSX)  
**⚠️ NOT in Reports Centre — lives in Listings section**

**What it contains:**  
Every listing on Flipkart — active, inactive, blocked, archived. This is the master reference for mapping FSN ↔ SKU ↔ product name ↔ listing quality across all other reports.

**Why manual frequency:**  
The listing catalog doesn't change daily. New SKUs are added periodically, listings are edited occasionally. Running this daily would waste resources. Run manually whenever SKUs are added or changed.

**Critical setting:**  
When downloading, the platform selector must be set to **"All"** (not "Flipkart" only). This includes Shopsy listings alongside Flipkart listings. Never change this to Flipkart-only.

**Portal navigation:**
1. Sidebar → hover "Listings" → click "My Listings"
2. Verify "All" is selected in platform tabs at top of page
3. Find "Downloads" button in the top-right button group (Sort By · **Downloads** · Uploads · Actions)
4. Click "Downloads" → dropdown: View Recent Downloads / **Download Listing File** / Download Catalog File (grayed) / Download Variant Grouping File
5. Click **"Download Listing File"**
6. "Downloads History" modal opens — new entry appears at top with "Generating X%" status
7. Poll until status shows green ✓ checkmark
8. Click download icon (↓) on the top entry
9. Intercept → upload to Drive

**File format note:**  
The downloaded file extension is `.xls` (older Excel format), NOT `.xlsx`. The mimeType in config.js is `application/vnd.ms-excel` accordingly.

**Filename pattern:** `S_listing--ui--group_<hash>_3005-<version>_default.xls` — version number increments each download. Always take the topmost entry.

---

### FK_VIEWS — Flipkart Traffic Report

**Drive folder key:** `FK_VIEWS`  
**Drive folder ID:** `1W05Pdgc_Fk7CbRIRUdtA6ZcTFM6SSrxz`  
**Frequency:** Daily  
**File format:** CSV or XLSX (verify on first download — button says "listings report")  
**⚠️ NOT in Reports Centre — lives in Growth → NXT Insights → Traffic Report**

**What it contains:**  
Listing-level traffic data — impressions (views), conversion rate, units sold, and a breakdown of where impressions came from:
- Search Results (~43% — customers searched and found the listing)
- Recommendations (~37% — Flipkart recommended the listing to browsing customers)
- Merchandise (~5% — banners, special placements)
- Other Sources (~16%)

**Why this report matters:**  
Tracks organic visibility of each listing. Falling impressions means the listing is losing search rank — a signal to review keywords, pricing, or listing quality. Rising impressions from "Recommendations" suggest Flipkart's algorithm is promoting the listing.

**Critical data lag:**  
Data is always 1-2 days behind. When today is 30 May, the latest available data is 28 May. Always read the latest date from the **"Latest" button label** on the page — do not assume "today minus 2".

**Portal navigation:**
1. Sidebar → hover "Growth" → click "Nxt Insights"
2. NXT Insights page loads → click **"Traffic Report"** tab
3. Platform selector — keep **"All"** (Flipkart + Shopsy)
4. Read the "Latest" button label → this is the most recent available date
5. Click "Custom Dates ∨" → calendar opens
6. Select From = `lastRun['fk_views']` + 1 day, To = latest available date
7. Click "Done" → page reloads showing data for selected range
8. Click **"Request Listings Report ↓"** (top-right)
9. Button changes to **"Generating Report..."** — wait (this takes longer than typical)
10. Button changes to **"Download Listings Report ↓"** — click it
11. Intercept → upload

**Polling the button:**  
The extension must watch the button text and only click when it reads "Download Listings Report". Check every 5 seconds up to `TIMEOUT_MS`.

---

### FK_KEYWORDS — Flipkart Keywords CSV

**Drive folder key:** `FK_KEYWORDS`  
**Drive folder ID:** `1VlwkUbx6bzLi1fw1F3qbO_klfDM3vNth`  
**Frequency:** Daily  
**File format:** CSV (built in-memory by content script — no download button)  
**⚠️ Same page as FK_VIEWS — run both jobs in one page load**

**What it contains:**  
For each SKU listing: the top 10 organic search keywords that customers used to find that listing, with each keyword's share of impressions and clicks.

**Output CSV format:**
```csv
Date,SKU,Keyword,Impression %,Clicks %
2026-05-28,DJ-1 S Bahubali (...,jhumka earrings,45%,12%
2026-05-28,DJ-1 S Bahubali (...,gold earrings,20%,8%
2026-05-28,DJ-15,temple jhumka,33%,18%
```

**Why this report matters:**  
Shows what customers search for to find Rumee's products. Informs which keywords to bid on in Flipkart Ads and how to optimize listing titles/descriptions for organic search. Each SKU can have completely different top keywords.

**IMPORTANT distinction:**  
- `fk_keywords` (this report) = **organic traffic** — what customers searched for naturally
- `fk_ads_kw` = **ads keyword report** — which keywords triggered the paid ads

These are different metrics and live in different Drive folders.

**How extraction works:**  
On the same Traffic Report page (after FK_VIEWS date is set), scroll down past the charts. A listing table appears with "View top search keywords" button per row. The content script:
1. Iterates through all rows on all pages
2. For each SKU: clicks the button, waits for the popup ("Top 10 Searched Keywords"), extracts the table data, closes the popup
3. Builds a CSV string in memory
4. Uploads to Drive via Drive API (not browser download — content script sends buffer to background)

**Reference script:**  
`C:\Users\jaisw\Desktop\Flipkart Keywords Extraction Code.txt` — the manual console script the user previously ran. The content script implements the same logic without any prompts/alerts.

---

### FK_ADS — Flipkart Ads Reports (7 Reports)

**⚠️ NOT in Reports Centre — path: Ads → Reports → Other Reports**  
**All 7 reports use the same page, same flow, different dropdown selection**  
**Frequency:** Daily for all  
**Format:** CSV (confirmed for Consolidated Daily Report; verify others)  
**Date selection:** Use "Yesterday" preset (one click, no calendar needed)

**Page navigation:**
1. Sidebar → hover "Ads" → click "Reports"
2. Ads Reports page loads with tabs: PLA | PCA | Other Reports
3. Click **"Other Reports"** tab
4. Set Ad Product = **PLA**
5. Set Report Type = [specific report — see table below]
6. Click Date → **"Yesterday"** (or Custom if catching up multiple days)
7. Click **"Download"** → file downloads immediately
8. Intercept → upload to the specific folder for this report type

**The 7 reports:**

| Job ID | Report Type Dropdown Value | Drive Folder Key | Drive Folder ID | What it contains |
|---|---|---|---|---|
| `fk_ads_daily` | Consolidated Daily Report | `FK_ADS_DAILY` | `1NaZuJ0-TMLQxHyceCL2u-MwRT6DQZGAf` | Daily metrics per campaign: Ad Spend, Views, Clicks, Units Sold, Revenue, ROI. One row per campaign per day. |
| `fk_ads_fsn` | Consolidated FSN Report | `FK_ADS_FSN` | `19A4TFrqORQ-NpM3M0APljKFpVZ9Fj0_N` | SKU-level attribution: which specific products got views, clicks, conversions from ads. |
| `fk_ads_placements` | Placement Performance Report | `FK_ADS_PLACEMENTS` | `1OouwwP4aVbAYkbCJe76zp2WOyfIN2G7o` | Where ads appeared (search results, category pages, recommendation spots). |
| `fk_ads_overall` | Overall Performance Report | `FK_ADS_OVERALL` | `1DpC5qI5_47QPxq_dda_Y1LV1UIaZf4SR` | Aggregate campaign performance summary across all campaigns. |
| `fk_ads_search` | Search Term Report | `FK_ADS_SEARCH` | `1fDvZU1SrJc4Ijixz-4vc_hMh7XYCtwCb` | Which search terms customers used that triggered the ads — used for bid optimization. |
| `fk_ads_orders` | Campaign Order Report | `FK_ADS_ORDERS` | `1iNICRCucsPG-cJbAgQ_lq4nM_Oj-W6mG` | Order-level attribution — which specific orders were driven by which ad campaigns. |
| `fk_ads_kw` | Keyword Report | `FK_ADS_KW` | `1kCZKj09s3pqZTDtl8Q3dHC0LD8BL5O_T` | Keyword-level performance for campaigns that use keyword targeting. |

**Confirmed file structure (Consolidated Daily Report):**
```
Start Time, 2026-05-29 00:00:00
End Time, 2026-05-29 23:59:59
Campaign ID, Campaign Name, Date, Ad Spend, Views, Clicks, Total converted units, Total Revenue (Rs.), ROI
3E708P1YY8SS, PLA_Campaign-2026-05-29 1, 2026-05-29, 287.80, 15792, 365, 1, 298.00, 1.03
LK6JHJG7DMZ8, PLA_Campaign-2026-05-29, 2026-05-29, 970.50, 32163, 647, 2, 623.00, 0.64
```

**Date constraint:** Max 1 month per request. If gap > 1 month, split into multiple requests.

**Master folder (reference only, not used for uploads):** `1ZhNhUH0Yl4ingB830PEgt6pHfHoc1T2S`

**Previously:** The business owner manually downloaded all 7 report types and compiled them into a single Excel file (`Consolidate ad report.xlsx` in the master folder). This extension replaces that manual process — each report type now goes to its own subfolder automatically.

---

## 10. Google Drive Folder Structure

```
Google Drive (rumeein@gmail.com)
│
├── Meesho/
│   ├── ME_ORDERS      1V0ZnC6r577zYJIYeyDhl8rItBrAXgnwQ
│   │   └── Files named: meesho_orders_YYYY-MM-DD.csv
│   │
│   ├── ME_RETURNS     1MEW8yK9lsercJ5k1gQIRh_xiOHpneSV8
│   │
│   ├── ME_PAYMENTS    1DoZoUTmNf6hMqC0-WlS2IWPzTDwyAwQr
│   │   └── Files are ZIPs: meesho_payments_YYYY-MM-DD.zip
│   │
│   ├── ME_ADS         1HMThJGvTIVygdjKh1pTyzbEblro4_0sk  ⚠️ Fix permissions
│   │
│   ├── ME_CLAIMS      1LX79E16fhxEF5kZGWmdXl4oNsVvqwspf  ⚠️ Fix permissions
│   │
│   ├── ME_CATALOG     1e7qdkFu6trp3BQDQdAY22i_INGvzKNeu
│   │   └── Daily full snapshots: meesho_inventory_YYYY-MM-DD.xlsx
│   │
│   └── ME_VIEWS       1EMqTpDtsratSY66UbbrV4VsnGIXYKFqV
│       └── Single growing CSV: meesho_views.csv (rows appended daily)
│
└── Flipkart/
    ├── FK_ORDERS      1-LzJJo3Wi3x6YrUjYCm7SYm3x2tWQqko
    │   └── Existing files: 01_2026.xlsx through 05_2026.xlsx (monthly)
    │
    ├── FK_RETURNS     PLACEHOLDER ⚠️ Create folder, update config.js
    │
    ├── FK_PAYMENTS    1KY-M0_7_FDm_GlqMht4HO2w2wzPRkSgp
    │   └── Existing files: 03_2026.xlsx, 04_2026.xlsx, 05_2026.xlsx
    │
    ├── FK_CLAIMS      1Ov-iVVqrl9KpCoZXUlqeV0tNTjGFQeD3  ⚠️ Fix permissions
    │   └── Existing: claim_report till 27 may 26.xlsx
    │
    ├── FK_LISTINGS    1sBCegMtxLxr02RkvmlJ5OGYHfD_raBnU
    │
    ├── FK_VIEWS       1W05Pdgc_Fk7CbRIRUdtA6ZcTFM6SSrxz
    │
    ├── FK_KEYWORDS    1VlwkUbx6bzLi1fw1F3qbO_klfDM3vNth
    │
    └── FK_ADS/        1ZhNhUH0Yl4ingB830PEgt6pHfHoc1T2S  (master — reference only)
        ├── daily/     1NaZuJ0-TMLQxHyceCL2u-MwRT6DQZGAf  ← Consolidated Daily
        ├── fsn/       19A4TFrqORQ-NpM3M0APljKFpVZ9Fj0_N  ← FSN Report
        ├── placements/ 1OouwwP4aVbAYkbCJe76zp2WOyfIN2G7o ← Placement Performance
        ├── overall/   1DpC5qI5_47QPxq_dda_Y1LV1UIaZf4SR  ← Overall Performance
        ├── search_terms/ 1fDvZU1SrJc4Ijixz-4vc_hMh7XYCtwCb ← Search Terms
        ├── orders/    1iNICRCucsPG-cJbAgQ_lq4nM_Oj-W6mG  ← Campaign Orders
        └── keywords/  1kCZKj09s3pqZTDtl8Q3dHC0LD8BL5O_T  ← Ads Keywords
```

### How File Routing Works

There is **no routing intelligence, no inbox folder, no LLM, no pattern matching.** Routing is entirely hardcoded:

1. Each job in `config.js` has a `folderKey` property
2. `DRIVE_FOLDERS[job.folderKey]` gives the exact Drive folder ID
3. The extension uploads to that folder ID directly
4. If you need a file to go somewhere else, change the `folderKey` or add a new folder ID — nothing else changes

```javascript
// This is all the "routing logic" that exists:
const folderId = DRIVE_FOLDERS[job.folderKey];
await uploadToDrive(fileBuffer, job.filename, folderId, job.mimeType);
```

---

## 11. Download Mechanisms

Different reports use different download methods. The content script uses the appropriate method for each:

### Method 1: Async Export Queue (Meesho Orders, Meesho Claims)

```
1. Click "Export" button
2. Portal queues the export (may take 1–5 minutes)
3. Content script refreshes the page
4. Finds the new file in the "Exported Files" list by date/timestamp
5. Clicks Download → intercepts the download URL
6. Sends URL to background → background fetches + uploads
```

### Method 2: Direct Browser Download (Meesho Payments, Meesho Catalog)

```
1. Click "Download" button
2. Portal immediately triggers a browser download
3. Content script intercepts via patched window.fetch or XHR:
   window._originalFetch = window.fetch;
   window.fetch = async function(...args) {
     // capture URL and headers
     return new Response('', {status: 200}); // cancel browser download
   };
4. Sends captured URL to background → background fetches + uploads
```

### Method 3: Flipkart Reports Centre (FK Orders, Returns, Payments)

```
1. Navigate to Reports Centre
2. Apply category filter
3. Find today's scheduled/requested report with Status="Generated"
4. Click "Download ↓" → intercept download URL
5. Background fetches + uploads
```

### Method 4: Direct API Call (Meesho Ads)

```
1. Navigate to Ads section
2. Inject fetch interceptor to capture browser-id header and API URLs
3. Trigger a page API call (click Yesterday button)
4. Interceptor captures the complete request including all headers
5. Background makes same API calls with captured headers
6. Builds XLSX from JSON response
7. Uploads to Drive
```

### Method 5: DOM Scrape + In-memory CSV (Meesho Views, Flipkart Keywords)

```
1. Navigate to the page
2. Read data from DOM elements (no download button exists)
3. Build CSV string in memory
4. Convert to ArrayBuffer
5. Send to background → upload to Drive as if it were a downloaded file
```

### Method 6: NXT Insights Traffic Report (FK Views)

```
1. Navigate to Traffic Report page
2. Select date range via custom date picker
3. Click "Request Listings Report" button
4. Poll button text until it shows "Download Listings Report"
5. Click → intercept download URL
6. Background fetches + uploads
```

---

## 12. Bot Detection & Human-like Behavior

### Meesho — Akamai Bot Manager

Meesho uses Akamai Bot Manager, a sophisticated bot detection system. Key risks and mitigations:

| Risk Factor | Our Mitigation |
|---|---|
| Headless browser fingerprint | Extension runs in real Chrome (not headless) — fingerprint is identical to a normal user |
| Missing session cookies | Extension uses the user's existing login session — cookies are real |
| Fixed, predictable timing | All delays use `base + Math.random() * variance` — never exactly the same |
| Missing mouse events | Full sequence: `mousemove → mouseenter → mouseover → mousedown → mouseup → click` |
| No scrolling before interaction | Small random scroll before interacting with any element |
| Direct URL jumps | Navigation via sidebar clicks (not `window.location.href = deepUrl`) |

**Random delay formula used throughout:**
```javascript
const sleep = (base, variance) =>
  new Promise(r => setTimeout(r, base + Math.random() * variance));

// Example: sleep between 800ms and 1800ms
await sleep(800, 1000);
```

### Flipkart

No significant bot detection observed. Direct URL navigation works fine.

---

## 13. Session Recovery

If the extension is mid-job and the portal redirects to the login page (session expired):

**Meesho:**
1. Content script detects it's on the login page (URL check)
2. Clicks the email input field — Chrome's saved passwords autofill the credentials
3. Clicks the Login button
4. Waits for redirect back to the portal
5. Resumes the job from the beginning (re-navigates to the target section)
6. **One attempt only** — if still on login page after, send `JOB_ERROR` to background
7. Background sends Chrome notification: "Meesho session expired — please log in manually"

**Flipkart:**  
Similar approach. If Flipkart session expires mid-job, attempt autofill login once, then notify if failed.

**Important:** The extension never stores credentials. It relies entirely on Chrome's saved password manager. If the user has not saved their credentials in Chrome, session recovery will fail and the user must log in manually before the next sync.

---

## 14. Installation & Setup Guide

### Prerequisites

- Google Chrome browser (not Edge, not Firefox)
- Must be logged into supplier.meesho.com in Chrome
- Must be logged into seller.flipkart.com in Chrome
- Chrome must have saved passwords for both portals (for session recovery)
- A Google account (the extension will create Drive folders automatically)

### Step 1: Load the Extension in Chrome

1. Open Chrome → address bar → `chrome://extensions`
2. Enable **"Developer mode"** (toggle, top-right)
3. Click **"Load unpacked"**
4. Select the extension folder (the folder containing `manifest.json`)
5. Extension appears in the list
6. Click the extension icon in the Chrome toolbar → the **Setup Screen** opens

### Step 2: Create Drive Folders (automatic)

On first install, the popup shows a setup screen instead of the main UI:
1. Click **"Create My Drive Folders"**
2. Chrome shows a Google sign-in consent screen → approve access
3. The extension automatically creates a folder called **"Rumee Auto Sync"** in your Google Drive, with all subfolders inside it (Flipkart/, Meesho/, System/)
4. Folder IDs are saved in the extension's local storage — you never need to touch them
5. The popup switches to the normal sync interface

**What gets created in Drive:**
```
Rumee Auto Sync/
  Flipkart/
    Orders, Returns, Payments, Claims, Listings, Views, Keywords
    Ads/ → Daily Report, FSN Report, Placements, Overall Performance,
            Search Terms, Campaign Orders, Keyword Report
  Meesho/
    Orders, Returns, Payments, Catalog, Views, Claims
    Ads/ → Master, Summary, Catalog
  System/
    Download Manifest
```

### Step 3: Test

1. Click the extension icon → popup opens (main sync UI)
2. Check that you are logged into both portals in the same Chrome profile
3. Click "Run Now" on a single job (suggest starting with `me_orders`)
4. A background tab briefly opens and closes
5. Check "Rumee Auto Sync → Meesho → Orders" in your Drive for the uploaded file

### OAuth Client ID Reference

The `manifest.json` has the OAuth client ID for the registered app:
```json
"oauth2": {
  "client_id": "710811509279-kkk24q7hef0ctel8bi5b4fs6m3sn7g8r.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

Each Google account (Chrome profile) authorizes independently. The extension only accesses files it creates — `drive.file` scope is narrower than full Drive access.

---

## 15. Flipkart Scheduled Reports Setup

Three Flipkart reports are configured as daily scheduled reports. **This only needs to be set up once.** Once active, Flipkart generates them automatically every day.

**Current status:** All 3 are already set up (done during recording session on 30 May 2026). Verify by checking the "Scheduled" tab in Reports Centre — should show 3 entries.

**How to set up (if ever need to recreate):**

For each report:
1. `seller.flipkart.com` → sidebar → hover "Reports" → click "Reports Centre"
2. Click **"Request New Report"** (top-right blue button)
3. Select the category (Fulfilment Reports or Payment Reports)
4. Select the sub-type (Orders / Returns / Settled Transactions)
5. Click **"Schedule Report"** tab (not "One Time Request")
6. Set: Every = `1`, Frequency = `Day`, Start Date = today
7. Click **Submit**

| Report | Category | Sub-type |
|---|---|---|
| FK_ORDERS | Fulfilment Reports | Orders |
| FK_RETURNS | Fulfilment Reports | Returns |
| FK_PAYMENTS | Payment Reports | Settled Transactions |

**What to verify:** After setup, "Scheduled" tab shows 3 entries, all with Frequency = 1 (Day) and Next Generated Date = tomorrow.

---

## 16. Operating the Extension (Daily Use)

### Automatic (no action needed)

The extension runs automatically at 09:00 every day (adjustable in popup). It:
- Checks which jobs are due
- Runs them in sequence
- Sends a notification when done

### Manual Trigger

Click the extension icon → popup → "Run Now" button. Can run all jobs or select specific ones.

### Checking Status

Click extension icon → popup shows:
- Current sync status (running/idle)
- Last run date per job
- Any failures from the most recent run

### If a Job Fails

1. Open popup → see which job failed and the error message
2. Common causes:
   - Portal session expired → log into the portal manually, then re-run the job
   - Drive folder permission error → check Section 17 Known Issues
   - Portal UI changed → the content script may need updating
3. Re-run the failed job via popup → "Run Now" → select specific job

### Changing the Schedule

Popup → Schedule section → change hour/minute → Save. The alarm is recreated immediately.

---

## 17. What the Pipeline Receives

The extension's job ends when the file lands in Drive. A separate pipeline (not part of this extension) processes the files. Here is what the pipeline can expect:

### File Naming Convention

The extension uploads files using the `filename` from each job's config.js definition. Some content scripts append dates to filenames — the exact convention depends on implementation. The pipeline should handle both fixed filenames (overwritten daily) and date-suffixed filenames.

### File Formats by Job

| Job | Format | Notes |
|---|---|---|
| ME_ORDERS | CSV | One row per order item |
| ME_RETURNS | CSV | One row per return, always last 2 weeks |
| ME_PAYMENTS | ZIP (contains XLSX) | Pipeline must unzip |
| ME_ADS | XLSX | Built by extension from API response |
| ME_CLAIMS | CSV | May overlap — deduplicate by ticket ID |
| ME_CATALOG | XLSX | Full snapshot daily |
| ME_VIEWS | CSV | Rows appended — date+views+orders |
| FK_ORDERS | XLSX (multi-sheet) | "Orders" sheet is primary |
| FK_RETURNS | XLSX | |
| FK_PAYMENTS | XLSX (multi-sheet) | 9 sheets — see Section 8 for sheet list |
| FK_CLAIMS | XLSX (2 sheets) | Deduplicate by Claim ID |
| FK_LISTINGS | XLS (not XLSX) | Reference catalog — run manually |
| FK_VIEWS | CSV or XLSX | Verify format on first download |
| FK_KEYWORDS | CSV | Date, SKU, Keyword, Impression%, Clicks% |
| FK_ADS_DAILY | CSV | Campaign ID, Name, Date, Spend, Views, Clicks, Units, Revenue, ROI |
| FK_ADS_FSN | CSV | SKU-level ad attribution |
| FK_ADS_PLACEMENTS | CSV | Placement breakdown |
| FK_ADS_OVERALL | CSV | Campaign aggregate |
| FK_ADS_SEARCH | CSV | Search terms that triggered ads |
| FK_ADS_ORDERS | CSV | Order-level ad attribution |
| FK_ADS_KW | CSV | Keyword-level ad performance |

### Deduplication Rules

| Report | Deduplicate by |
|---|---|
| ME_RETURNS | AWB Number |
| ME_CLAIMS | Ticket ID |
| FK_CLAIMS | Claim ID |
| FK_KEYWORDS | Date + SKU + Keyword |
| All others | Date range per file (no overlap expected) |

---

## 18. Known Issues & Pending Actions

| Priority | Issue | Detail | Action |
|---|---|---|---|
| 🔴 **BLOCKER** | Extension icons missing | Chrome will not load the extension | Create 3 PNG files in `icons/` folder (16px, 48px, 128px) |
| 🟡 High | FK_RETURNS Drive folder missing | Job will fail silently — uploads go nowhere | Create Drive folder, paste ID into `config.js` `FK_RETURNS` value |
| 🟡 High | ME_ADS folder permissions | canAddChildren: false → uploads silently fail | Share folder `1HMThJGvTIVygdjKh1pTyzbEblro4_0sk` with rumeein@gmail.com as Editor |
| 🟡 High | ME_CLAIMS folder permissions | Same as above | Share folder `1LX79E16fhxEF5kZGWmdXl4oNsVvqwspf` as Editor |
| 🟡 High | FK_CLAIMS folder permissions | Same as above | Share folder `1Ov-iVVqrl9KpCoZXUlqeV0tNTjGFQeD3` as Editor |
| 🟢 Low | FK_ORDERS scheduled report date range | Unknown whether auto-generated report covers yesterday only or rolling window | Check when first scheduled report appears on 31 May 2026 |
| 🟢 Low | FK_VIEWS file format | Config says CSV but not confirmed | Verify file extension when first download completes |
| 🟢 Info | Meesho 1-month max range | Orders portal enforces 1-month max date range | Content script must split large gaps into multiple ≤30-day requests |

---

## 19. How to Add a New Report

1. **Identify the report** — which portal, which section, what download mechanism

2. **Create a Drive folder** for the report → copy the folder ID from the URL

3. **Add folder to `DRIVE_FOLDERS`** in `config.js`:
   ```javascript
   NEW_REPORT_KEY: 'your-drive-folder-id',
   ```

4. **Add a job to `JOBS`** in `config.js`:
   ```javascript
   {
     id:        'new_report_id',        // unique, snake_case
     platform:  'meesho',              // or 'flipkart'
     label:     'Human-readable name', // shown in notifications and popup
     startUrl:  'https://...',         // URL that opens when job starts
     folderKey: 'NEW_REPORT_KEY',      // matches DRIVE_FOLDERS key
     filename:  'output_filename.csv', // base filename for Drive upload
     mimeType:  'text/csv',            // MIME type for Drive
     frequency: 'daily',               // 'daily', '3day', or 'manual'
   }
   ```

5. **Add a handler in the content script** (`meesho.js` or `flipkart.js`):
   ```javascript
   if (job.id === 'new_report_id') {
     await handleNewReport(job);
     return;
   }
   ```

6. **Implement the handler** — navigate to the section, intercept the download, send `DOWNLOAD_URL_CAPTURED` to background

7. **Test** — manually trigger via popup "Run Now", check Drive for the uploaded file

8. **Document in `DOCS.md`** — add a full section following the same format as existing reports:
   - What it contains
   - Why it matters
   - Key columns
   - Navigation path
   - Date range logic
   - Any special notes

---

## 20. Multi-Account & Multi-Business Use

### How Google Accounts Work

The extension uses Chrome's built-in Google login. It does **not** store any credentials or account information.

| What | How |
|---|---|
| Which Google Drive gets the files | Determined by which Google account is signed into Chrome |
| Multiple businesses | Use separate Chrome Profiles (one per business) |
| Each profile's Drive | Completely separate — no mixing |

**To use for a second business:** create a new Chrome Profile → log into that profile's Google account + seller portals → install the extension → click "Create My Drive Folders". That's it.

### Drive Folder IDs Are Per-Install

On each fresh install:
- The setup wizard creates a new "Rumee Auto Sync" folder in that profile's Drive
- Folder IDs are saved locally to that Chrome profile
- Unrelated to any other install or profile

If you need to see or reset the saved folder IDs:
1. `chrome://extensions` → click "Details" on the extension → "Extension options" (or developer tools)
2. Or open the extension's background page → Console → `chrome.storage.local.get('customFolders', console.log)`

### Upgrading an Existing Install

When you update the extension from an older version (one without the setup wizard):
- The extension detects it is an **update** (not a fresh install)
- It automatically migrates the old hardcoded folder IDs to storage
- No setup screen is shown — your existing Drive folders continue to be used
- No data is moved or changed in Drive

---

## 21. Chrome Web Store Publishing (Future Reference)

This section documents what is needed if the extension is ever published to the Chrome Web Store. Nothing here needs to be done now.

### What Changes When Publishing

| Item | Sideloaded (current) | Chrome Web Store |
|---|---|---|
| Installation | Load unpacked in developer mode | One-click install from store page |
| Updates | Reload manually in `chrome://extensions` | Chrome updates all users automatically |
| OAuth Client ID | Same ID, works as-is | Must be re-registered — Google verifies it during review |
| Drive API quota | Free tier, per Google account | Same — no charges for typical volumes |
| Extension ID | Changes on each reload | Fixed permanently after publishing |
| Distribution | Share the folder manually | Anyone can find and install from the store |

### OAuth Re-Registration Steps (when publishing)

1. Google Cloud Console → your project → Credentials
2. Edit the existing OAuth 2.0 Client ID → change Application Type from "Chrome Extension (sideloaded)" to "Chrome Extension"
3. Enter the **permanent Extension ID** from the Chrome Web Store (given after first submission)
4. Save → update `manifest.json` with the new client ID if it changed
5. During Chrome Web Store review, Google verifies the client ID matches

### Pricing Options

| Model | How |
|---|---|
| Free | Publish with no price — anyone installs for free |
| One-time purchase | Set a price in the Web Store Developer Dashboard |
| Free + external subscription | Free install, subscription managed on your own website |

Google takes 30% of any payment made through the Chrome Web Store. You receive 70%.

### What Stays the Same

- All the logic, jobs, and content scripts — no code changes needed for publishing
- Each user's Google Drive is separate — folder auto-creation works identically
- Users' Meesho/Flipkart sessions are their own — the extension uses their browser login

### Pre-Publishing Checklist

- [ ] Extension icons present in `icons/` (16px, 48px, 128px)
- [ ] `manifest.json` version number incremented
- [ ] OAuth Client ID re-registered with the permanent Extension ID
- [ ] Privacy policy URL added to Web Store listing (Google requires one)
- [ ] Screenshots and promotional images prepared for the store listing
- [ ] Extension tested on a clean Chrome profile (fresh install, no prior data)
- [ ] All jobs verified working on the final build

---

## 22. Glossary

| Term | Full Form | Meaning in context |
|---|---|---|
| AWB | Air Waybill | Logistics tracking number for a shipment |
| COD | Cash on Delivery | Payment method where customer pays on delivery |
| CPC | Cost Per Click | Ad pricing model — pay per click on your ad |
| CVR | Conversion Rate | % of views that result in a purchase |
| FBF | Fulfilled by Flipkart | Orders where Flipkart's warehouse stores and ships the product |
| FSN | Flipkart Serial Number | Flipkart's internal product identifier (like SKU but Flipkart's own) |
| GMV | Gross Merchandise Value | Total sales value before deductions |
| MV3 | Manifest Version 3 | Current Chrome Extension standard (replaced MV2) |
| NEFT | National Electronic Funds Transfer | Bank transfer used for payment settlements in India |
| P&L | Profit and Loss | Net financial outcome per order or period |
| PLA | Product Listing Ad | Flipkart's standard sponsored product ad format |
| ROI | Return on Investment | Revenue generated per rupee spent on ads |
| ROAS | Return on Ad Spend | Revenue ÷ ad spend |
| RTO | Return to Origin | Package returned to seller because delivery failed |
| SKU | Stock Keeping Unit | Seller's own product identifier (e.g., "DJ-1 S Bahubali") |
| SLA | Service Level Agreement | Promised time window (e.g., dispatch within 24 hours) |
| SPF | Seller Protection Fund | Flipkart's compensation program for sellers who receive wrong/damaged returns |
| SPA | Single Page Application | Web app that loads once and updates content without full page reloads |
| TCS | Tax Collected at Source | Tax collected by marketplace from seller |
| TDS | Tax Deducted at Source | Tax deducted before payment to seller |

---

---

## 23. Flipkart UI Internals & Timing Behavior

This section documents hard-won knowledge about how specific Flipkart UI elements behave and timing constraints that affect automation reliability. Recorded from debugging sessions in June 2026.

---

### FK Reports Centre — 2-Day Date Range Design

When the extension requests a report via Reports Centre (FK_ORDERS, FK_RETURNS, FK_PAYMENTS), it always submits a **2-day range**: start = d-1 (day before yesterday), end = d (yesterday). Not a single-day range.

**Why a 2-day range:**  
Flipkart's Reports Centre requires the start date to be strictly before the end date — you cannot request a single-day report. The minimum valid range is 2 days. The extension uses `[yesterday-1, yesterday]` as its 2-day window.

**How `findReportRowDownloadBtn` matches the correct row:**  
The function matches rows by their **END date** (the date after " To " in the row label), not the start date. This is correct because the end date is always `yesterday` and that uniquely identifies the report we just requested.

```
Row text example: "Fulfilment Reports  Orders  05 Jun 2026 To 06 Jun 2026  Generated"
                                                                ^^^^^^^^^^^
                                        This is what we match — the END date (yesterday)
```

**Log note:** The log always prints `StepE: clicked start date YYYY-MM-DD` using the computed `sD` value. If `findDayCell(sD)` fails and falls back to `calCell`, the log still shows the originally-computed `sD`. To confirm which cell was actually clicked, check whether `findDayCell` returned truthy in a diagnostic run — the log alone is not sufficient proof.

---

### FK_PAYMENTS — Afternoon Timing Constraint

**Symptom:** `fk_payments` submits successfully but "SUBMIT clicked but success banner never appeared" is logged. The report is not found in the Requested tab for hours.

**Root cause:** Flipkart generates payment settlement reports only once a day, in the **afternoon** (approximately after 13:00–14:00 IST). When the extension runs in the morning at 09:00, Flipkart accepts the report request but the report stays in "Requested" or "Processing" state for hours.

**This is NOT a code bug.** The submission flow, date selection, and banner detection code are all correct. The banner simply doesn't appear in the morning because Flipkart hasn't finalized the settlement data yet.

**How the extension handles it:**  
After each RC job run, `handleFkRCReport` checks which sub-reports are still missing. If `fk_payments` is not yet available, it schedules a `fk_rc_recheck` alarm for 60 minutes later. It retries up to 3 times (i.e., up to 3 hours of retries). By the time the afternoon recheck runs, the report is ready and downloads normally.

**Confirmed via test:** A test using date range Jun 1→Jun 2 (historical, data already finalized) showed the green success banner appearing correctly within 15 seconds. The banner detection code works — it's purely a data-availability timing issue.

---

### FK Reports Centre — Calendar Picker UI

The Reports Centre "Custom Dates" picker is a **standard two-month calendar** (one month on the left, next month on the right). No unusual behavior.

**What a correct calendar looks like:** May 2026 on the left panel, Jun 2026 on the right panel (or whichever two consecutive months span the desired date range). Each month has its own cell grid for days.

**StepD opens the calendar as follows:**
1. Click the date range label (shows current date range, e.g., "01 Jun 2026 - 06 Jun 2026")
2. "Custom" chip appears → click it
3. Two-month calendar opens

**StepE clicks dates:**
1. `findDayCell(sD, monthText1, monthText2)` → finds the correct day cell for the start date in the visible calendar
2. Click start cell → wait 900–1600ms
3. `findDayCell(d, monthText1, monthText2)` → finds end date cell
4. Click end cell → wait 800–1400ms

---

### `findDayCell` — Month Disambiguation Logic

**Problem:** The Flipkart seller portal contains hidden dropdown elements that list all 12+ months (used for month-selection menus elsewhere on the page). When the extension searches for elements with text "Jun 2026", it finds both the visible calendar header and these hidden month-list elements.

**What the log shows when this happens:**
```
13 month labels found — rejecting this header candidate
13 month labels found — rejecting this header candidate
...
Found correct calendar container via single-month panel check
```

**This is NOT an error.** The code is working correctly — it walks through every element that matches "Jun 2026", rejects those that are inside containers with many month labels (= hidden dropdown menus), and accepts only the element inside a container that has exactly one month label (= the visible calendar panel).

**The logic:**
```javascript
// For each candidate element matching "Jun 2026":
const container = walkUpUntilSingleMonth(candidate);
if (container has exactly 1 month label) {
  // This is the real calendar — use its day cells
} else {
  // This is a hidden dropdown — reject and try next candidate
}
```

**If you see "13 month labels" repeatedly in logs:** Expected behavior. It will resolve to the real calendar and continue. Only a problem if it never finds a single-month container — which would mean the calendar is not open.

---

### FK_VIEWS — Two-Phase Download Flow

FK_VIEWS is split into two separate jobs to handle the "Generating Report" delay:

| Phase | Job ID | What it does |
|---|---|---|
| 1 | `fk_views_request` | Opens Traffic Report, selects date range, clicks "Request Listings Report", checks button state |
| 2 | `fk_views` | Opens Traffic Report again, re-selects same date range, clicks "Download Listings Report" |

**Why two phases:** After clicking "Request Listings Report", Flipkart may take minutes to generate the file. If still generating, a 60-minute `fk_views_recheck` alarm is scheduled. When the alarm fires, `fk_views` runs and clicks the now-ready Download button.

**`fkViewsSelectRange` state machine:**  
After clicking Done on the date picker, the function waits 6 seconds and checks the button state:

```
state = {
  requestBtn:   true  → report not yet requested for this range
  generating:   true  → report is being generated (wait and retry)
  downloadBtn:  true  → report is ready, click to download
}
```

**Important:** Both phases re-select the date range via the custom date picker. This is intentional — navigating directly to the Traffic Report page resets to the "Latest" preset, so the range must be re-applied each time.

**fk_views_range in storage:**  
`fk_views_request` stores the chosen date range (`{from, to}`) in `chrome.storage.local` under key `fk_views_range`. `fk_views` reads this to know which range to re-select in the download phase.

---

### FK_VIEWS — Calendar Disambiguation (same as RC)

The same 13-month-label issue affects the FK_VIEWS custom date picker (NXT Insights Traffic Report page). `fkViewsClickDay` uses the identical single-month-container detection logic (`fkViewsClickDay` → walks up from candidate, rejects multi-month containers).

When logs show repeated "rejecting this header — N month labels", this is expected and the code resolves to the correct calendar. FK_VIEWS successfully downloaded dates Jun 10, Jun 11, and Jun 12 in the same sync run (confirmed by Drive upload confirmations), validating that the calendar logic works correctly.

---

### Log Buffer Overflow During Multi-Day Catch-Up Runs

**Symptom:** Logs from the last few jobs in a long run are missing. It looks like the job never completed even though Drive shows the uploaded file.

**Root cause:** The extension log buffer is capped at 2000 entries. When multiple missed-day alarms fire at once (e.g., Jun 9, Jun 10, Jun 11, Jun 12 all missed and running together), the total log entries across all jobs exceeds 2000. Early jobs' success messages push out late jobs' entries. The buffer is a circular queue — oldest entries are dropped first.

**How to verify completion independently of logs:**
1. Check Google Drive directly for the uploaded file
2. Check `chrome.storage.local` → `lastRun` → the job ID's date should be updated
3. Check the extension popup — it shows last successful run date per job

**Rule of thumb:** If Drive has the file and `lastRun` is updated, the job succeeded regardless of what the log shows (or doesn't show). Logs are best-effort diagnostics, not a reliable audit trail for large batch runs.

---

### Multiple Concurrent Sync Runs (Missed-Day Alarms)

When the extension misses its daily alarm for several days (e.g., Chrome was closed), multiple "missed day" alarms fire at startup — one for each missed day. This causes several sync runs to execute in parallel or rapid succession, one for each date.

**Each sync run is independent:**
- Each uploads files with their respective date in the filename
- Drive's upsert logic prevents duplicates (file with same name is updated, not duplicated)
- Each run updates `lastRun[jobId]` only for its own date

**This is expected and harmless.** The data is correct; only the logs are hard to read because multiple runs interleave their output.

---

*Document version: 1.2 — Sections 19–20 added 2026-06-13: multi-account use + Chrome Web Store publishing reference. Section 13 updated: auto folder creation setup flow.*  
*Companion files: `recording.md` (UI navigation details), `config.js` (all job and folder definitions)*
