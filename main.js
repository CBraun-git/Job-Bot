import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import dayjs from 'dayjs';

await Actor.init();

const searchTerms = [
    "Head of HR",
    "Leiter Personal",
    "Personalleitung",
    "Personalleiter",
    "Head of Stuff",
    "HR Manager"
];

const results = [];

const crawler = new PlaywrightCrawler({
    async requestHandler({ page, request }) {
        const { label, term } = request.userData;

        await page.waitForSelector('[data-testid="job-result-title"]');

        const items = await page.$$eval('[data-testid="job-result"]', (jobs) =>
            jobs.map((el) => {
                const title = el.querySelector('[data-testid="job-result-title"]')?.innerText?.trim();
                const company = el.querySelector('[data-testid="company-name"]')?.innerText?.trim();
                const location = el.querySelector('[data-testid="job-location"]')?.innerText?.trim();
                const link = el.querySelector('a')?.href;
                const description = el.querySelector('[data-testid="job-snippet"]')?.innerText?.trim();
                const posted = el.querySelector('[data-testid="posting-date"]')?.innerText?.trim();
                return { title, company, location, link, description, posted };
            })
        );

        items.forEach((item) => {
            if (
                item.title &&
                item.title.toLowerCase().includes(term.toLowerCase()) &&
                item.title.toLowerCase().includes("vollzeit")
            ) {
                results.push({
                    ...item,
                    source: "mynejo.de",
                    posted_at: item.posted,
                    date_found: new Date().toISOString(),
                });
            }
        });
    },
    maxRequestsPerCrawl: 100,
    maxConcurrency: 3,
});

const startUrls = searchTerms.map((term) => ({
    url: `https://www.mynejo.de/jobs?keywords=${encodeURIComponent(term)}&location=Ulm&radius=100`,
    userData: { label: 'SEARCH', term },
}));

await crawler.run(startUrls);

const uniqueResults = results.filter(
    (job, index, self) => index === self.findIndex((t) => t.link === job.link)
);

await Actor.call('apify/send-webhook-request', {
    webhookUrl: 'https://golden-stable-gull.ngrok-free.app/webhook-test/e50e9f23-3959-4ec9-9b24-2364e327a9b6',
    payload: uniqueResults,
});

await Actor.exit();
