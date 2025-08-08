import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import dayjs from 'dayjs';

const WEBHOOK_URL = 'https://golden-stable-gull.ngrok-free.app/webhook-test/e50e9f23-3959-4ec9-9b24-2364e327a9b6';

const SEARCH_TERMS = [
  'Head of HR',
  'Leiter Personal',
  'Personalleitung',
  'Personalleiter',
  'Head of Stuff',
  'HR Manager',
];

const BASE_URL = 'https://www.mynejo.de/jobs';

function buildSearchUrl(term) {
  const params = new URLSearchParams({
    keywords: term,
    location: 'Ulm',
    radius: '100',
    // Falls es Filter-Parameter für Vollzeit gibt, hier ergänzen, sonst später clientseitig filtern
  });
  return `${BASE_URL}?${params.toString()}`;
}

async function safeClick(page, selector) {
  try {
    await page.locator(selector).click({ timeout: 3000 });
  } catch (_) {}
}

async function closeCookieBanner(page) {
  // versuche ein paar gängige Muster
  await safeClick(page, 'button:has-text("Akzeptieren")');
  await safeClick(page, 'button:has-text("Alle akzeptieren")');
  await safeClick(page, 'button[aria-label*="accept" i]');
  await safeClick(page, 'button[aria-label*="akzeptieren" i]');
}

function normalizeText(t) {
  return (t ?? '').replace(/\s+/g, ' ').trim();
}

async function postToWebhook(items) {
  if (!items.length) return;

  // in sinnvollen Chunks senden (ngrok/n8n mögen keine riesigen Bodies)
  const CHUNK = 100;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Webhook POST failed: ${res.status} ${res.statusText} ${body}`);
    }
  }
}

await Actor.init();
log.setLevel(log.LEVELS.INFO);

const results = [];
const seenLinks = new Set();

const crawler = new PlaywrightCrawler({
  headless: true,
  navigationTimeoutSecs: 30,
  maxConcurrency: 3,
  requestHandlerTimeoutSecs: 90,

  async requestHandler({ page, request }) {
    const { term, pageNo = 1 } = request.userData;
    log.info(`🔎 Suche "${term}" – Seite ${pageNo}: ${request.url}`);

    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await closeCookieBanner(page);

    // Warte auf irgendeinen Ergebniscontainer – nutze mehrere Fallbacks
    const selectors = [
      '[data-testid="job-result"]',
      '.job-result, .result-item, [class*="job"] [class*="result"]', // generische Fallbacks
      'li:has(a[href*="/job/"])',
    ];

    let found = false;
    for (const sel of selectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        found = true;
        break;
      } catch (_) {}
    }
    if (!found) {
      log.warning(`⚠️ Keine Treffer-Selectoren gefunden für "${term}" – Seite ${pageNo}`);
      return;
    }

    // Extraktion mit robusten Fallbacks
    const items = await page.evaluate(() => {
      const out = [];
      const containers = document.querySelectorAll('[data-testid="job-result"], .job-result, .result-item, li');
      containers.forEach((el) => {
        const linkEl =
          el.querySelector('a[href*="/job/"]') ||
          el.querySelector('a[href*="/jobs/"]') ||
          el.querySelector('a[href*="/stellen"]') ||
          el.querySelector('a');

        const titleEl =
          el.querySelector('[data-testid="job-result-title"]') ||
          el.querySelector('h2, h3, [class*="title"]');

        const companyEl =
          el.querySelector('[data-testid="company-name"]') ||
          el.querySelector('[class*="company"], [data-company]');

        const locationEl =
          el.querySelector('[data-testid="job-location"]') ||
          el.querySelector('[class*="location"]');

        const snippetEl =
          el.querySelector('[data-testid="job-snippet"]') ||
          el.querySelector('p, [class*="snippet"], [class*="teaser"]');

        const postedEl =
          el.querySelector('[data-testid="posting-date"]') ||
          el.querySelector('time, [class*="date"]');

        const link = linkEl?.href || '';
        const title = titleEl?.textContent || '';
        const company = companyEl?.textContent || '';
        const location = locationEl?.textContent || '';
        const description = snippetEl?.textContent || '';
        let posted = postedEl?.getAttribute?.('datetime') || postedEl?.textContent || '';

        out.push({ link, title, company, location, description, posted });
      });
      return out;
    });

    const nowIso = new Date().toISOString();

    for (const raw of items) {
      const link = normalizeText(raw.link);
      if (!link || seenLinks.has(link)) continue;
      seenLinks.add(link);

      // Vollzeit: wenn Filter auf der Website nicht verfügbar ist, heuristisch im Text prüfen
      const blob = `${raw.title} ${raw.description}`.toLowerCase();
      const isFulltime = /vollzeit|full[-\s]?time/.test(blob);

      const record = {
        title: normalizeText(raw.title),
        company: normalizeText(raw.company),
        location: normalizeText(raw.location),
        link,
        source: 'mynejo.de',
        description: normalizeText(raw.description),
        posted_at: normalizeText(raw.posted),
        date_found: nowIso,
      };

      if (isFulltime) {
        results.push(record);
        // Für Debug zusätzlich ins Default-Dataset schreiben
        await Dataset.pushData(record);
      }
    }

    // Pagination: „Weiter“ oder Seitenlinks versuchen
    let nextClicked = false;
    const nextSelectors = [
      'a[rel="next"]',
      'a:has-text("Weiter")',
      'button:has-text("Weiter")',
      'a:has-text("Nächste")',
      'button:has-text("Nächste")',
      'a.pagination-next, button.pagination-next',
    ];
    for (const sel of nextSelectors) {
      const has = await page.locator(sel).count();
      if (has > 0) {
        try {
          await page.locator(sel).first().click();
          await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
          nextClicked = true;
          break;
        } catch (e) {
          log.debug(`Pagination click failed on ${sel}: ${e?.message || e}`);
        }
      }
    }

    if (nextClicked) {
      // aktuelle Seite erneut behandeln (nach Navigation)
      return;
    }

    // sonst Ende dieser Term-Suche
    log.info(`✅ Fertig für "${term}" – Seite ${pageNo}`);
  },

  failedRequestHandler({ request, error }) {
    log.error(`❌ Request fehlgeschlagen: ${request.url}\n${error?.stack || error}`);
  },
});

const startRequests = SEARCH_TERMS.map((term) => ({
  url: buildSearchUrl(term),
  userData: { term, pageNo: 1 },
}));

await crawler.run(startRequests);

// Duplikate (falls Links mehrfach auftauchen)
const unique = [];
const seen = new Set();
for (const r of results) {
  if (!seen.has(r.link)) {
    seen.add(r.link);
    unique.push(r);
  }
}

log.info(`📦 Gesamt gefundene Vollzeit‑Jobs: ${unique.length}`);

// Webhook senden
try {
  await postToWebhook(unique);
  log.info(`📨 An Webhook gesendet (${unique.length} Records).`);
} catch (e) {
  log.error(`Webhook Fehler: ${e?.message || e}`);
  // Nicht crashe — Daten bleiben im Dataset zur Analyse
}

await Actor.exit();
