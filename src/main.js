// Finn.no jobs scraper - CheerioCrawler implementation (with sector/industry/etc)
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            // category is no longer used in output, but we still accept it in input for compatibility
            category: INPUT_CATEGORY, // eslint-disable-line no-unused-vars
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            cookies,
            cookiesJson,
            dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;

        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 999;

        const toAbs = (href, base = 'https://www.finn.no') => {
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const cleanText = (htmlOrText) => {
            if (!htmlOrText) return '';
            const $ = cheerioLoad(String(htmlOrText));
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc) => {
            const u = new URL('https://www.finn.no/job/search');
            if (kw) u.searchParams.set('q', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location));

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;
        const seenListUrls = new Set();
        const seenDetailUrls = new Set();

        // LIST → DETAIL: carry basic metadata (company, location, date_posted)
        const detailMeta = new Map(); // key: normalized URL, value: { title, company, location, date_posted }

        const cookieHeaderFromJson = (() => {
            if (!cookiesJson) return null;
            try {
                const parsed = JSON.parse(cookiesJson);
                if (Array.isArray(parsed)) {
                    return parsed.map((c) => `${c.name}=${c.value}`).join('; ');
                }
                if (parsed && typeof parsed === 'object') {
                    return Object.entries(parsed)
                        .map(([k, v]) => `${k}=${v}`)
                        .join('; ');
                }
            } catch (e) {
                log.warning(`Failed to parse cookiesJson: ${e.message}`);
            }
            return null;
        })();

        const cookieHeader = cookies || cookieHeaderFromJson || null;

        const normalizeJob = (job) => ({
            url:
                job?.canonical_url ||
                job?.url ||
                (job?.id ? `https://www.finn.no/job/ad/${job.id}` : null),
            title: job?.heading || job?.jobTitle || job?.title || null,
            company: job?.company_name || job?.company?.name || null,
            location: job?.location?.combined || job?.location?.postalName || job?.location || null,
            date_posted: job?.published || job?.datePosted || null,
        });

        function extractJobsFromHtml($) {
            const jobs = [];
            $('a.sf-search-ad-link, a[href*="/job/ad/"]').each((_, link) => {
                const href = $(link).attr('href');
                const urlAbs = toAbs(href);
                if (!urlAbs) return;

                const article = $(link).closest('article');
                const title =
                    ($(link).text() || article.find('h1,h2,h3').first().text() || '').trim() ||
                    null;

                const metaText = (article
                    .find('.text-xs, time, .sf-search-ad__meta')
                    .first()
                    .text() || ''
                )
                    .replace(/\s+/g, ' ')
                    .trim();

                let date_posted = null;
                let locationGuess = null;
                if (metaText.includes('|')) {
                    const parts = metaText
                        .split('|')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (parts.length) date_posted = parts[0] || null;
                    if (parts.length > 1) locationGuess = parts[1] || null;
                }

                const company =
                    (article
                        .find('[data-automation-id="search-result-company"]')
                        .first()
                        .text() ||
                        article.find('.flex.flex-col.text-xs span').first().text() ||
                        article
                            .find(
                                '[class*="company"], .company, .employer, [data-automation-id*="employer"]',
                            )
                            .first()
                            .text() ||
                        '')
                        .trim() || null;

                const location =
                    (locationGuess ||
                        article
                            .find('[data-automation-id="search-result-location"]')
                            .first()
                            .text() ||
                        article
                            .find('[class*="location"], .location')
                            .first()
                            .text() ||
                        '')
                        .trim() || null;

                jobs.push({
                    url: urlAbs,
                    title,
                    company,
                    location,
                    date_posted,
                });
            });
            return jobs;
        }

        function extractJobDetailsFromJson($) {
            let job = null;
            $('script').each((_, script) => {
                const content = $(script).html() || '';
                const match =
                    content.match(/"jobAd"\s*:\s*(\{.*?\})/s) ||
                    content.match(/jobAd\s*[:=]\s*(\{.*?\})/s);
                if (match) {
                    try {
                        job = JSON.parse(match[1]);
                    } catch {
                        // ignore
                    }
                }
            });
            if (!job) return null;

            return {
                title: job.heading || job.jobTitle,
                company: job.company?.name || job.employer || null,
                date_posted: job.published || job.datePosted || null,
                description_html: job.description || job.body || null,
                location:
                    job.location?.postalName ||
                    job.location?.streetAddress ||
                    job.location?.city ||
                    null,
                // if Finn ever exposes these, we map:
                sector: job.sector || null,
                industry: job.industry || null,
                job_function: job.occupation || job.jobFunction || null,
                employment_type: job.engagementType || job.employment_type || null,
            };
        }

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            const candidates = [];

            const collect = (obj) => {
                if (!obj) return;
                if (Array.isArray(obj)) return obj.forEach(collect);
                if (obj['@graph']) return collect(obj['@graph']);
                const t = obj['@type'] || obj.type;
                if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                    candidates.push(obj);
                }
            };

            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    collect(parsed);
                } catch {
                    // ignore
                }
            }

            if (!candidates.length) return null;
            const e = candidates[0];

            const hiringOrg =
                (e.hiringOrganization && e.hiringOrganization.name) ||
                e.hiringOrganization ||
                null;

            let jobLocation = null;
            if (e.jobLocation) {
                const jLoc = Array.isArray(e.jobLocation)
                    ? e.jobLocation[0]
                    : e.jobLocation;
                if (jLoc && jLoc.address) {
                    const addr = jLoc.address;
                    jobLocation =
                        addr.addressLocality ||
                        addr.addressRegion ||
                        addr.addressCountry ||
                        null;
                } else if (jLoc?.addressLocality) {
                    jobLocation = jLoc.addressLocality;
                }
            }

            return {
                title: e.title || e.name || null,
                company: hiringOrg,
                date_posted: e.datePosted || e.datePublished || null,
                description_html: e.description || null,
                location: jobLocation,
                sector: e.industry || null, // best-effort mapping
                industry: e.industry || null,
                job_function: e.occupationalCategory || null,
                employment_type: e.employmentType || null,
            };
        }

        // Extract a field from raw text, supporting multiple label variants
        function extractField(bodyText, labels) {
            if (!bodyText) return null;
            for (const label of labels) {
                const re = new RegExp(`${label}\\s*:\\s*([^\\n#]+)`, 'i');
                const m = bodyText.match(re);
                if (m && m[1]) return m[1].trim();
            }
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            preNavigationHooks: [
                ({ request }) => {
                    request.headers['user-agent'] =
                        request.headers['user-agent'] ||
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
                    if (cookieHeader) request.headers.Cookie = cookieHeader;
                },
            ],
            async requestHandler({ request, response, $, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (!response) {
                    crawlerLog.warning(`No response for ${request.url}`);
                    return;
                }

                let jobs = [];

                // JSON API responses
                if (response.headers['content-type']?.includes('json')) {
                    try {
                        const data = typeof response.body === 'string'
                            ? JSON.parse(response.body)
                            : response.body;
                        const rawJobs = Array.isArray(data) ? data : data.jobs || [];
                        jobs = rawJobs.map(normalizeJob);
                    } catch (e) {
                        crawlerLog.error(`Failed to parse JSON: ${e.message}`);
                        return;
                    }
                } else if ($ && label === 'LIST') {
                    jobs = extractJobsFromHtml($);
                }

                if (label === 'LIST') {
                    if (saved >= RESULTS_WANTED) return;

                    const remaining = RESULTS_WANTED - saved;

                    const uniqueJobs = jobs.filter((j) => {
                        if (!j.url) return false;
                        const key = j.url.split('?')[0];
                        if (dedupe && seenListUrls.has(key)) return false;
                        if (dedupe) seenListUrls.add(key);

                        detailMeta.set(key, {
                            url: key,
                            title: j.title || null,
                            company: j.company || null,
                            location: j.location || null,
                            date_posted: j.date_posted || null,
                        });
                        return true;
                    });

                    crawlerLog.info(
                        `LIST page ${pageNo} -> found ${uniqueJobs.length} new jobs (remaining ${remaining})`,
                    );

                    if (collectDetails) {
                        const toEnqueue = uniqueJobs.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            await Promise.all(
                                toEnqueue.map((job) =>
                                    crawler.requestQueue?.addRequest({
                                        url: job.url,
                                        userData: { label: 'DETAIL' },
                                    }),
                                ),
                            );
                        }
                    } else {
                        const toPush = uniqueJobs.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            await Dataset.pushData(
                                toPush.map((j) => ({
                                    title: j.title || null,
                                    company: j.company || null,
                                    // no category anymore
                                    location: j.location || null,
                                    date_posted: j.date_posted || null,
                                    url: j.url,
                                    _source: 'finn.no',
                                })),
                            );
                            saved += toPush.length;
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && $) {
                        const nextPageNo = pageNo + 1;
                        let nextUrl = null;

                        const nextHref = $(`a[href*="page=${nextPageNo}"]`).first().attr('href');
                        if (nextHref) nextUrl = toAbs(nextHref, request.loadedUrl || request.url);

                        if (!nextUrl) {
                            const u = new URL(request.loadedUrl || request.url);
                            u.searchParams.set('page', String(nextPageNo));
                            nextUrl = u.href;
                        }

                        if (nextUrl) {
                            await crawler.requestQueue?.addRequest({
                                url: nextUrl,
                                userData: { label: 'LIST', pageNo: nextPageNo },
                            });
                        }
                    }

                    return;
                }

                // DETAIL pages
                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    if (!$) {
                        crawlerLog.error(`No Cheerio instance on DETAIL ${request.url}`);
                        return;
                    }

                    try {
                        const key = (request.loadedUrl || request.url).split('?')[0];
                        if (dedupe && seenDetailUrls.has(key)) return;
                        if (dedupe) seenDetailUrls.add(key);

                        const fromList = detailMeta.get(key) || {};

                        const json = extractJobDetailsFromJson($) || extractFromJsonLd($) || {};
                        const data = { ...json };

                        // Basic text for regex-based extraction
                        const fullHtml = $.root().html() || '';
                        const bodyText = cleanText(fullHtml);

                        // Title
                        if (!data.title) {
                            data.title =
                                $('h1').first().text().trim() ||
                                fromList.title ||
                                null;
                        }

                        // Company
                        if (!data.company) {
                            data.company =
                                $('[data-automation-id*="employer"], [data-testid*="employer"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[class*="company"], .company, .employer')
                                    .first()
                                    .text()
                                    .trim() ||
                                fromList.company ||
                                null;
                        }

                        // Description (HTML + text)
                        if (!data.description_html) {
                            let descEl =
                                $('[data-automation-id*="ad-body"], [data-testid*="ad-body"]').first();
                            if (!descEl.length) descEl = $('[data-automation-id="job-description"]').first();
                            if (!descEl.length) descEl = $('main').first();
                            if (!descEl.length) descEl = $('article').first();
                            if (!descEl.length) descEl = $('body').first();

                            if (descEl && descEl.length) {
                                data.description_html = String(descEl.html() || '').trim() || null;
                            }
                        }
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // Location
                        if (!data.location) {
                            const locFromDom =
                                $('[data-automation-id="job-location"], [class*="location"], .location')
                                    .first()
                                    .text()
                                    .trim() || null;
                            const locFromText = extractField(bodyText, ['Sted', 'Location']);
                            data.location =
                                locFromDom ||
                                locFromText ||
                                fromList.location ||
                                null;
                        }

                        // Date posted
                        if (!data.date_posted) {
                            if (fromList.date_posted) {
                                data.date_posted = fromList.date_posted;
                            } else {
                                const frist = bodyText.match(/Frist\s+([0-9.\- ]{8,})/i);
                                const sistEndret = bodyText.match(
                                    /Sist endret\s+([0-9.\-,: ]{8,})/i,
                                );
                                if (frist && frist[1]) data.date_posted = frist[1].trim();
                                else if (sistEndret && sistEndret[1]) {
                                    data.date_posted = sistEndret[1].trim();
                                }
                            }
                        }

                        // New fields: sector, industry, job_function, employment_type
                        const sector =
                            data.sector ||
                            extractField(bodyText, ['Sektor', 'Sector']) ||
                            null;
                        const industry =
                            data.industry ||
                            extractField(bodyText, ['Bransje', 'Industry']) ||
                            null;
                        const jobFunction =
                            data.job_function ||
                            extractField(bodyText, ['Stillingsfunksjon', 'Job function']) ||
                            null;
                        const employmentType =
                            data.employment_type ||
                            extractField(bodyText, ['Ansettelsesform', 'Employment type']) ||
                            null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            sector,
                            location: data.location || null,
                            industry,
                            job_function: jobFunction,
                            employment_type: employmentType,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: key,
                            _source: 'finn.no',
                        };

                        await Dataset.pushData(item);
                        saved++;

                        if (!item.description_html || !item.company) {
                            crawlerLog.debug(
                                `DETAIL missing fields for ${key} (company: ${!!item.company}, description_html: ${!!item.description_html})`,
                            );
                        }
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            },
        });

        // Seed run
        await crawler.run(
            initial
                .map((u) => toAbs(u))
                .filter(Boolean)
                .map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })),
        );

        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
