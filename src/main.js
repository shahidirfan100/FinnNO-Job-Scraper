// Finn.no jobs scraper - CheerioCrawler implementation (single job pages fixed)
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Initialize Actor
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            // category accepted for backwards compatibility, but not used in output
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

        // Normalize numeric inputs
        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;

        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 999;

        // Helpers
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
            $('script, style, noscript, iframe, template').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc) => {
            const u = new URL('https://www.finn.no/job/search');
            if (kw) u.searchParams.set('q', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            return u.href;
        };

        // Build initial URLs
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

        // LIST → DETAIL: keep metadata for fallback (company, location, date_posted)
        const detailMeta = new Map(); // key: normalized URL, value: { title, company, location, date_posted }

        // Cookie handling
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

        // Normalize job object from JSON APIs (if any)
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

        // Extract jobs from LIST (search results) HTML
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

        // Try extracting job details from custom "jobAd" JSON blob in scripts
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
                sector: job.sector || null,
                industry: job.industry || null,
                job_function: job.occupation || job.jobFunction || null,
                employment_type: job.engagementType || job.employment_type || null,
            };
        }

        // Try extracting from JSON-LD JobPosting
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
                sector: e.industry || null, // best-effort
                industry: e.industry || null,
                job_function: e.occupationalCategory || null,
                employment_type: e.employmentType || null,
            };
        }

        // Extract <li><span class="font-bold">Label:</span> Value...</li> style fields inside a section
        function extractLabeledValue($, section, labelText) {
            if (!section || !section.length) return null;
            let value = null;
            section.find('li').each((_, li) => {
                if (value) return;
                const $li = $(li);
                const bold = $li.find('span.font-bold').first();
                if (!bold.length) return;
                const label = bold.text().replace(/[:\s]+$/, '').trim().toLowerCase();
                if (label === labelText.toLowerCase()) {
                    const clone = $li.clone();
                    clone.find('span.font-bold').remove();
                    value = clone.text().replace(/\s+/g, ' ').trim();
                }
            });
            return value;
        }

        // Extract deadline & employment type ("Frist", "Ansettelsesform") from top metadata list
        function extractTopMeta($) {
            let deadline = null;
            let employmentType = null;

            $('ul li').each((_, li) => {
                if (deadline && employmentType) return;
                const text = $(li).text().replace(/\s+/g, ' ').trim();
                if (!deadline && text.startsWith('Frist')) {
                    deadline = text.replace(/^Frist\s*/i, '').trim();
                }
                if (!employmentType && text.startsWith('Ansettelsesform')) {
                    employmentType = text.replace(/^Ansettelsesform\s*/i, '').trim();
                }
            });

            return { deadline, employmentType };
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
                // Determine label (LIST vs DETAIL), but auto-detect job/ad URLs
                let label = request.userData?.label || 'LIST';
                try {
                    const path = new URL(request.loadedUrl || request.url).pathname;
                    if (/\/job\/ad\//.test(path)) {
                        label = 'DETAIL'; // Single job pages
                    }
                } catch {
                    // ignore
                }

                const pageNo = request.userData?.pageNo || 1;

                if (!response) {
                    crawlerLog.warning(`No response for ${request.url}`);
                    return;
                }

                let jobs = [];

                // JSON API (if any)
                if (response.headers['content-type']?.includes('json')) {
                    try {
                        const data =
                            typeof response.body === 'string'
                                ? JSON.parse(response.body)
                                : response.body;
                        const rawJobs = Array.isArray(data) ? data : data.jobs || [];
                        jobs = rawJobs.map(normalizeJob);
                    } catch (e) {
                        crawlerLog.error(`Failed to parse JSON: ${e.message}`);
                        return;
                    }
                } else if ($ && label === 'LIST') {
                    // LIST HTML page
                    jobs = extractJobsFromHtml($);
                }

                // -------- LIST PAGES --------
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
                                    // No category in output
                                    location: j.location || null,
                                    date_posted: j.date_posted || null,
                                    url: j.url,
                                    _source: 'finn.no',
                                })),
                            );
                            saved += toPush.length;
                        }
                    }

                    // Pagination
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

                // -------- DETAIL PAGES (single job) --------
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

                        // Structured data first
                        const json = extractJobDetailsFromJson($) || extractFromJsonLd($) || {};
                        const data = { ...json };

                        // Full HTML text (for date fallbacks only)
                        const fullHtml = $.root().html() || '';
                        const bodyText = cleanText(fullHtml);

                        // --- TITLE ---
                        if (!data.title) {
                            // Prefer H2.t2 (actual job title)
                            let title =
                                $('section h2.t2')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('h2.t2')
                                    .first()
                                    .text()
                                    .trim() ||
                                null;

                            if (!title) {
                                // Fallback: first H1
                                title = $('h1').first().text().trim() || null;
                            }
                            if (!title && fromList.title) title = fromList.title;
                            data.title = title || null;
                        }

                        // --- COMPANY ---
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

                        // --- DESCRIPTION_HTML (only job description, not whole page) ---
                        if (!data.description_html) {
                            // 1) First .import-decoration is usually the main job description
                            let descEl = $('.import-decoration').first();

                            // 2) Older layouts / alternate selectors
                            if (!descEl.length) {
                                descEl = $(
                                    '[data-testid="ad-description"], [data-automation-id="job-description"]',
                                ).first();
                            }

                            if (descEl && descEl.length) {
                                const clone = descEl.clone();
                                clone.find('script, style, template, iframe, svg').remove();

                                let html = clone.html() || '';

                                // Strip noisy attributes (optional but makes HTML cleaner)
                                html = html.replace(/\sdata-[a-zA-Z0-9-]+="[^"]*"/g, '');
                                html = html.replace(/\s(?:class|id|style)="[^"]*"/g, '');
                                html = html.trim();

                                data.description_html = html.length ? html : null;
                            }
                        }

                        // --- DESCRIPTION_TEXT ---
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // --- LOCATION ---
                        if (!data.location) {
                            // Try within "Om arbeidsgiveren" section
                            const employerSection = $('h2:contains("Om arbeidsgiveren")').closest(
                                'section',
                            );
                            const locFromSection = extractLabeledValue(
                                $,
                                employerSection,
                                'Sted',
                            );
                            const locFromDom =
                                $('[data-automation-id="job-location"], [class*="location"], .location')
                                    .first()
                                    .text()
                                    .trim() || null;

                            data.location =
                                locFromSection ||
                                locFromDom ||
                                fromList.location ||
                                null;
                        }

                        // --- DATE_POSTED (best effort) ---
                        if (!data.date_posted) {
                            if (fromList.date_posted) {
                                data.date_posted = fromList.date_posted;
                            } else {
                                const sistEndret = bodyText.match(
                                    /Sist endret\s+([0-9.\-,: ]{8,})/i,
                                );
                                if (sistEndret && sistEndret[1]) {
                                    data.date_posted = sistEndret[1].trim();
                                }
                            }
                        }

                        // --- TOP META: deadline & employment type ---
                        const { employmentType } = extractTopMeta($);

                        // --- SECTOR / INDUSTRY / JOB_FUNCTION / EMPLOYMENT_TYPE ---
                        const employerSection = $('h2:contains("Om arbeidsgiveren")').closest(
                            'section',
                        );

                        const sector =
                            data.sector ||
                            extractLabeledValue($, employerSection, 'Sektor') ||
                            null;

                        const industry =
                            data.industry ||
                            extractLabeledValue($, employerSection, 'Bransje') ||
                            null;

                        const jobFunction =
                            data.job_function ||
                            extractLabeledValue($, employerSection, 'Stillingsfunksjon') ||
                            null;

                        const employment_type =
                            data.employment_type ||
                            employmentType ||
                            extractLabeledValue($, employerSection, 'Ansettelsesform') ||
                            null;

                        // Final item
                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            sector,
                            location: data.location || null,
                            industry,
                            job_function: jobFunction,
                            employment_type,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: key,
                            _source: 'finn.no',
                        };

                        await Dataset.pushData(item);
                        saved++;

                        if (!item.title || !item.company || !item.description_html) {
                            crawlerLog.debug(
                                `DETAIL missing fields for ${key} (title: ${!!item.title}, company: ${!!item.company}, description_html: ${!!item.description_html})`,
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
