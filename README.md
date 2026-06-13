# Rumee Auto Sync — Chrome Extension

Downloads Flipkart & Meesho reports on a daily schedule and uploads them directly
to your Google Drive folders (the same ones the pipeline already reads from).

---

## Setup (one-time)

### 1 — Fix Drive folder permissions (REQUIRED before first run)

Three folders have `canAddChildren: false` — the extension will silently fail to
upload to them until you fix this:

| Folder | Drive ID |
|--------|----------|
| flipkart/claims | `1Ov-iVVqrl9KpCoZXUlqeV0tNTjGFQeD3` |
| meesho/ads      | `1HMThJGvTIVygdjKh1pTyzbEblro4_0sk` |
| meesho/claims   | `1LX79E16fhxEF5kZGWmdXl4oNsVvqwspf` |

Fix: open each folder in drive.google.com → right-click → Share → confirm your
Google account is listed as Owner or Editor.

---

### 2 — Create a Google Cloud OAuth2 client

1. Go to https://console.cloud.google.com/
2. Create a new project (e.g. "Rumee Sync")
3. Enable **Google Drive API** (APIs & Services → Library → search "Drive API")
4. Go to APIs & Services → Credentials → Create Credentials → **OAuth 2.0 Client ID**
5. Application type: **Chrome Extension**
6. During creation you'll need the extension ID — get it after step 3 below
   (you can edit the credential afterward to add the ID)
7. Copy the **Client ID** (looks like `123456789-abc.apps.googleusercontent.com`)

---

### 3 — Install the extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `rumee-extension/` folder
4. Copy the Extension ID shown on the card (e.g. `abcdefghijklmnopqrstuvwxyz123456`)

---

### 4 — Wire up the OAuth2 client ID

1. Open `manifest.json`
2. Replace `YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com` with your real Client ID
3. Go back to Google Cloud Console → the OAuth2 credential → add your Extension ID
   to the list of authorised Chrome extensions
4. Reload the extension in `chrome://extensions` (click the refresh icon)

---

### 5 — First run

1. Make sure you are **logged in** to both seller.flipkart.com and supplier.meesho.com
   in Chrome before running
2. Click the Rumee icon in the toolbar → popup opens
3. Click **▶ Run selected now** (start with just Meesho Orders to test)
4. Chrome will ask for Google Drive permission — click **Allow**
5. Watch the popup status; check your Drive folder for the uploaded file

---

## Testing order (important)

Test Meesho content script FIRST before running the full queue.

1. Run `me_orders` alone via popup
2. Open the background service worker console:
   `chrome://extensions` → Rumee → "Service worker" link → Console tab
3. Look for `[Rumee/Meesho] Captured download URL` log line
4. If you see `No download URL intercepted within timeout`:
   - The button selector needs updating — open supplier.meesho.com/orders manually,
     DevTools → Inspector → find the Download button → update `SEL.DOWNLOAD_BTN` in
     `content/meesho.js`
5. If background fetch returns HTML (not CSV): Akamai cookie check — log out of
   Meesho, log back in, retry
6. Once `me_orders` works, run all Meesho jobs, then Flipkart

---

## Updating selectors

Meesho and Flipkart update their UI periodically. When a job stops working:

1. Open the relevant seller panel page manually in Chrome
2. Right-click the Download/Export button → Inspect
3. Find a stable attribute (`data-testid`, unique class name)
4. Update the matching constant in:
   - `content/meesho.js`  → `SEL` object at the top
   - `content/flipkart.js` → `SEL_FK` object at the top
5. Reload extension → re-test

---

## Files & folders

```
rumee-extension/
  manifest.json       Extension manifest (MV3)
  config.js           All Drive folder IDs + job definitions — edit here
  background.js       Service worker: scheduling, orchestration, Drive upload
  popup.html/js/css   Extension popup UI
  content/
    meesho.js         Meesho page automation + download URL interception
    flipkart.js       Flipkart page automation + download URL interception
  drive/
    upload.js         Google Drive resumable upload helper
  icons/              16×16, 48×48, 128×128 PNG icons (create these)
```

---

## Creating icons

Any 16×16, 48×48, 128×128 PNG files work. Quick option — run this in a browser
console to generate a plain coloured square and save it:

```javascript
// paste in browser console, right-click the image, Save As
const c = document.createElement('canvas');
c.width = c.height = 48;
const ctx = c.getContext('2d');
ctx.fillStyle = '#7C3A1E';
ctx.fillRect(0, 0, 48, 48);
ctx.fillStyle = '#fff';
ctx.font = 'bold 20px Arial';
ctx.fillText('R', 14, 32);
document.body.appendChild(c);
```

Save three sizes: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.

---

## Architecture notes

- **MV3 service worker** — all state stored in `chrome.storage.local`; worker can
  sleep between jobs and resume from where it left off
- **Download interception** — content script patches `window.fetch` + `XMLHttpRequest`
  to capture the download URL; sends URL + Referer to background; background
  re-fetches with `credentials: include` (avoids 64MB sendMessage limit)
- **Drive upload** — resumable upload protocol; handles files of any size
- **No disk writes** — file bytes go directly from background fetch → Drive upload;
  nothing is written to the Downloads folder
