// ─── Rumee Extension — Shared Config ─────────────────────────────────────────
// Loaded in both background (via importScripts) and content scripts (via manifest).
// Edit ONLY this file to change folder IDs or add/remove jobs.

// ── Google Drive folder IDs ───────────────────────────────────────────────────
const DRIVE_FOLDERS = {
  FK_ORDERS:   '1-LzJJo3Wi3x6YrUjYCm7SYm3x2tWQqko',
  FK_RETURNS:  '1T0BkL4p5Yhaqh63141l5P3Gb5Tp3dyxd',
  FK_ADS:             '1ZhNhUH0Yl4ingB830PEgt6pHfHoc1T2S',  // master folder (reference only)
  FK_ADS_DAILY:       '1NaZuJ0-TMLQxHyceCL2u-MwRT6DQZGAf',  // Consolidated Daily Report
  FK_ADS_FSN:         '19A4TFrqORQ-NpM3M0APljKFpVZ9Fj0_N',  // Consolidated FSN Report
  FK_ADS_PLACEMENTS:  '1OouwwP4aVbAYkbCJe76zp2WOyfIN2G7o',  // Placement Performance Report
  FK_ADS_OVERALL:     '1DpC5qI5_47QPxq_dda_Y1LV1UIaZf4SR',  // Overall Performance Report
  FK_ADS_SEARCH:      '1fDvZU1SrJc4Ijixz-4vc_hMh7XYCtwCb',  // Search Term Report
  FK_ADS_ORDERS:      '1iNICRCucsPG-cJbAgQ_lq4nM_Oj-W6mG',  // Campaign Order Report
  FK_ADS_KW:          '1kCZKj09s3pqZTDtl8Q3dHC0LD8BL5O_T',  // Ads Keyword Report (≠ FK_KEYWORDS)
  FK_VIEWS:           '1W05Pdgc_Fk7CbRIRUdtA6ZcTFM6SSrxz',
  FK_KEYWORDS:        '1VlwkUbx6bzLi1fw1F3qbO_klfDM3vNth',  // Traffic keywords per SKU (recorded separately)
  FK_LISTINGS: '1sBCegMtxLxr02RkvmlJ5OGYHfD_raBnU',
  FK_PAYMENTS: '1KY-M0_7_FDm_GlqMht4HO2w2wzPRkSgp',
  FK_CLAIMS:   '1Ov-iVVqrl9KpCoZXUlqeV0tNTjGFQeD3',
  ME_ORDERS:   '1V0ZnC6r577zYJIYeyDhl8rItBrAXgnwQ',
  ME_RETURNS:  '1MEW8yK9lsercJ5k1gQIRh_xiOHpneSV8',
  ME_CATALOG:  '1e7qdkFu6trp3BQDQdAY22i_INGvzKNeu',
  ME_PAYMENTS: '1DoZoUTmNf6hMqC0-WlS2IWPzTDwyAwQr',
  ME_VIEWS:    '1EMqTpDtsratSY66UbbrV4VsnGIXYKFqV',
  ME_ADS:      '1HMThJGvTIVygdjKh1pTyzbEblro4_0sk',  // parent (reference only)
  ME_ADS_MASTER:  '1yQFg3HuOwtFpEFtx0ZYtBQPChSlpvL54',  // master: live campaigns, lifetime (one row/campaign, upsert by ID)
  ME_ADS_SUMMARY: '18qeRzJmTl6detS6Q3GEuK9gAnn8MZjDB',  // per-campaign per-day campaign summary
  ME_ADS_CATALOG: '1VDrfDM5uy2Xs2E9XCR7Ijk1BBwh2pO2F',  // per-campaign per-day catalog detail
  ME_CLAIMS:   '1LX79E16fhxEF5kZGWmdXl4oNsVvqwspf',
  DOWNLOAD_MANIFEST: '1vvgGD0UEHwV6G3X4txTjghyshmuk7Ufa',  // Rumee Raw Data/Download Manifest
  SYNC_LOG:          '1zqHbDZ20589xtFEaF921zX0ILoKhy8zO',  // Rumee Sync Logs/rumee_sync_log.csv
};

// ── Job definitions ───────────────────────────────────────────────────────────
// frequency:
//   'daily'   — run every day
//   '3day'    — run every 3 days (views, keywords — data refreshes slowly)
//   'manual'  — never auto-run; only via popup "Run now" button
//              (catalog & listings — only meaningful when SKUs change)
//
// startUrl: the page the extension navigates to before the content script acts.
// The content script reads window.location to decide what to do.
const JOBS = [
  // ── FK REPORTS CENTRE REQUESTS (run FIRST — reports generate while other jobs run) ──
  // Each submits a request to Flipkart Reports Centre and proceeds immediately.
  // fk_rc_download (last job) polls for all 3 and downloads when ready.
  {
    id:        'fk_orders',
    platform:  'flipkart',
    label:     'Flipkart Orders XLSX',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ORDERS',
    filename:  'flipkart_orders.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
    reportType:    'Fulfilment Reports',
    reportSubType: 'orders',
  },
  {
    id:        'fk_returns',
    platform:  'flipkart',
    label:     'Flipkart Returns CSV',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_RETURNS',
    filename:  'flipkart_returns.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },
  {
    id:        'fk_payments',
    platform:  'flipkart',
    label:     'Flipkart Payments XLSX',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_PAYMENTS',
    filename:  'flipkart_payments.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
    reportType:    'Payment Reports',
    reportSubType: 'settled transactions',
  },
  {
    // Phase 1 of the FK Views two-phase flow: submits the Traffic Report
    // listings-report request for the pending date range and moves on.
    // fk_views (runs after fk_rc_download) downloads it once generated.
    id:        'fk_views_request',
    platform:  'flipkart',
    label:     'Flipkart Views — Request Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_VIEWS',
    filename:  'flipkart_views.xlsx',   // not used — request only
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
  },

  // ── MEESHO ──
  // startUrl uses the panel home (always has /panel/ in path) so the content
  // script's isLoginPage() check doesn't misfire on the public Meesho homepage.
  // goToPage() then navigates from panel home → the correct section URL.
  {
    id:        'me_orders',
    platform:  'meesho',
    label:     'Meesho Orders CSV',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_ORDERS',
    filename:  'meesho_orders.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },
  {
    id:        'me_returns',
    platform:  'meesho',
    label:     'Meesho Returns CSV',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_RETURNS',
    filename:  'meesho_returns.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },
  {
    id:        'me_payments',
    platform:  'meesho',
    label:     'Meesho Payments ZIP',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_PAYMENTS',
    filename:  'meesho_payments.zip',
    mimeType:  'application/zip',
    frequency: 'daily',
  },
  {
    id:        'me_ads',
    platform:  'meesho',
    label:     'Meesho Ads Cost XLSX',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_ADS',
    filename:  'meesho_ads.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
  },
  {
    id:        'me_claims',
    platform:  'meesho',
    label:     'Meesho Support Tickets CSV',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_CLAIMS',
    filename:  'meesho_tickets.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },
  {
    id:        'me_catalog',
    platform:  'meesho',
    label:     'Meesho Inventory XLSX',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_CATALOG',
    filename:  'meesho_inventory.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',    // daily — tracks stock changes and inventory levels
  },
  {
    id:        'me_views',
    platform:  'meesho',
    label:     'Meesho Views CSV',
    startUrl:  'https://supplier.meesho.com/panel/v3/new/growth/xuptj/home',
    folderKey: 'ME_VIEWS',
    filename:  'meesho_views.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },

  // ── FLIPKART ADS — 7 separate report types, all from:
  //    Ads → Reports → Other Reports → Ad Product: PLA → Report Type: [each below]
  //    Date: "Yesterday" preset for daily runs. All upload directly to their own subfolder.
  {
    id:        'fk_ads_daily',
    platform:  'flipkart',
    label:     'Flipkart Ads — Consolidated Daily Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_DAILY',
    filename:  'flipkart_ads_daily.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Consolidated Daily Report',
  },
  {
    id:        'fk_ads_fsn',
    platform:  'flipkart',
    label:     'Flipkart Ads — Consolidated FSN Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_FSN',
    filename:  'flipkart_ads_fsn.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Consolidated FSN Report',
  },
  {
    id:        'fk_ads_placements',
    platform:  'flipkart',
    label:     'Flipkart Ads — Placement Performance Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_PLACEMENTS',
    filename:  'flipkart_ads_placements.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Placement Performance Report',
  },
  {
    id:        'fk_ads_overall',
    platform:  'flipkart',
    label:     'Flipkart Ads — Overall Performance Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_OVERALL',
    filename:  'flipkart_ads_overall.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Overall Performance Report',
  },
  {
    id:        'fk_ads_search',
    platform:  'flipkart',
    label:     'Flipkart Ads — Search Term Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_SEARCH',
    filename:  'flipkart_ads_search_terms.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Search Term Report',
  },
  {
    id:        'fk_ads_orders',
    platform:  'flipkart',
    label:     'Flipkart Ads — Campaign Order Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_ORDERS',
    filename:  'flipkart_ads_orders.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Campaign Order Report',
  },
  {
    id:        'fk_ads_kw',
    platform:  'flipkart',
    label:     'Flipkart Ads — Keyword Report',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ADS_KW',
    filename:  'flipkart_ads_keywords.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
    adsReportType: 'Keyword Report',
    // NOTE: this is Ads keyword data — different from FK_KEYWORDS (traffic per SKU)
  },
  {
    id:        'fk_claims',
    platform:  'flipkart',
    label:     'Flipkart Claims XLSX',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_CLAIMS',
    filename:  'flipkart_claims.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
  },
  {
    id:        'fk_listings',
    platform:  'flipkart',
    label:     'Flipkart Master Listing XLS',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_LISTINGS',
    filename:  'flipkart_listings.xls',
    mimeType:  'application/vnd.ms-excel',   // .xls not .xlsx
    frequency: 'daily',
  },
  {
    // Runs after all other FK jobs (~20-30 min after requests were submitted).
    // Checks if fk_orders, fk_returns, fk_payments reports are Generated.
    // If all ready → downloads immediately.
    // If any still generating → notifies user + schedules 1-hour alarm.
    // User confirms "Download Now" from notification → downloads start.
    id:        'fk_rc_download',
    platform:  'flipkart',
    label:     'FK Reports Centre Download',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_ORDERS',  // not used directly — each sub-job uses its own
    filename:  'fk_rc_download.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
  },
  {
    // Phase 2 of the FK Views two-phase flow. Runs near the END of the sync —
    // by now the listings report requested by fk_views_request (~30+ min ago)
    // should be generated. Re-selects the identical stored range; downloads if
    // ready, else schedules a 1-hour recheck (max 3) like fk_rc_download.
    // Flipkart serves this report as XLSX — stored in its native format.
    id:        'fk_views',
    platform:  'flipkart',
    label:     'Flipkart Views XLSX',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_VIEWS',
    filename:  'flipkart_views.xlsx',
    mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    frequency: 'daily',
  },
  {
    // Phase 2 of the FK Returns two-phase flow. Runs near the END of the sync —
    // by now the return report requested by fk_returns (~30-60 min ago) should
    // be Generated. Navigates to All Returns page, opens Previous Downloads panel,
    // finds the matching row, intercepts Download click, fetches and uploads CSV.
    id:        'fk_returns_download',
    platform:  'flipkart',
    label:     'FK Returns — Download',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_RETURNS',
    filename:  'flipkart_returns.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },
  {
    // Phase 2 of FK Listings two-phase flow. Runs just before fk_keywords —
    // by now the file triggered by fk_listings (~30-60 min ago) should be ready.
    // Opens View Recent Downloads, finds the Listing file, downloads and uploads.
    // If still Generating: schedules fk_listings_recheck alarm (60 min, max 3x).
    id:        'fk_listings_download',
    platform:  'flipkart',
    label:     'FK Listings -- Download',
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_LISTINGS',
    filename:  'flipkart_listings.xls',
    mimeType:  'application/vnd.ms-excel',
    frequency: 'daily',
  },
  {
    // ALWAYS RUNS LAST — requires user to manually navigate to:
    // Growth → Seller Insights → Traffic Report → "Latest" → "All"
    // Extension sends a notification when it's ready to scrape.
    id:        'fk_keywords',
    platform:  'flipkart',
    label:     'Flipkart Keywords CSV',
    skipNavigation: true,   // run from current FK tab without reloading
    startUrl:  'https://seller.flipkart.com/',
    folderKey: 'FK_KEYWORDS',
    filename:  'flipkart_keywords.csv',
    mimeType:  'text/csv',
    frequency: 'daily',
  },
];

// How long to wait (ms) for a page element or download URL before declaring failure
const TIMEOUT_MS = 30000;

// How long to wait (ms) between jobs (gives tabs time to settle)
const JOB_GAP_MS = 4000;
