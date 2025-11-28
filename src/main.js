// Finn.no jobs scraper - CheerioCrawler implementation (improved)
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
            category: INPUT_CATEGORY = '',
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
            // category not directly supported in URL; kept for future mapping
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, INPUT_CATEGORY));

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;
        const seenListUrls = new Set();
        const seenDetailUrls = new Set();

        // LIST → DETAIL metadata map
        const detailMeta = new Map(); // key: normalized URL (without query), value: { url, title, company, location, date_posted }

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
            // Main job cards
            $('a.sf-search-ad-link, a[href*="/job/ad/"]').each((_, link) => {
                const href = $(link).attr('href');
                const urlAbs = toAbs(href);
                if (!urlAbs) return;

                const article = $(link).closest('article');
                const title =
                    ($(link).text() ||
                        article.find('h1,h2,h3').first().text() ||
                        '')?.trim() || null;

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
            // Some FINN pages expose a jobAd JSON blob in a <script>
            let job = null;
            $('script').each((_, script) => {
                const content = $(script).html() || '';
                const match = content.match(/"jobAd"\s*:\s*(\{.*?\})/s) || content.match(/jobAd\s*[:=]\s*(\{.*?\})/s);
                if (match) {
                    try {
                        job = JSON.parse(match[1]);
                    } catch {
                        // ignore parsing errors; we'll fall back to other strategies
                    }
                }
            });
            if (job) {
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
                };
            }
            return null;
        }

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            const candidates = [];

            const collect = (obj) => {
                if (!obj) return;
                if (Array.isArray(obj)) {
                    obj.forEach(collect);
                    return;
                }
                if (obj['script:ld+json']) {
                    collect(obj['script:ld+json']);
                }
                if (obj.jobPosting) {
                    collect(obj.jobPosting);
                }
                if (obj['@graph']) {
                    collect(obj['@graph']);
                }
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
                    // ignore parsing errors; move on
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
            };
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

                // If we've already satisfied the quota, skip extra work
                if (saved >= RESULTS_WANTED && label === 'LIST') {
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
                } else if ($) {
                    // HTML pages
                    if (label === 'LIST') {
                        jobs = extractJobsFromHtml($);
                    }
                }

                if (label === 'LIST') {
                    const remaining = RESULTS_WANTED - saved;

                    const uniqueJobs = jobs.filter((j) => {
                        if (!j.url) return false;
                        const key = j.url.split('?')[0];
                        if (dedupe && seenListUrls.has(key)) return false;
                        if (dedupe) seenListUrls.add(key);
                        // store metadata for DETAIL fallback
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
                            // Enqueue detail pages (metadata kept in global map)
                            await Promise.all(
                                toEnqueue.map((job) => {
                                    const urlAbs = job.url;
                                    if (!urlAbs) return null;
                                    return crawler.requestQueue?.addRequest({
                                        url: urlAbs,
                                        userData: { label: 'DETAIL' },
                                    });
                                }),
                            );
                        }
                    } else {
                        const toPush = uniqueJobs.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            await Dataset.pushData(
                                toPush.map((j) => ({ ...j, _source: 'finn.no' })),
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

                        // Structured data first
                        const json = extractJobDetailsFromJson($) || extractFromJsonLd($) || {};
                        const data = { ...json };

                        // Title
                        if (!data.title) {
                            data.title =
                                $('h1').first().text().trim() ||
                                fromList.title ||
                                null;
                        }

                        // Company – selectors → "Om arbeidsgiveren" → list-data
                        if (!data.company) {
                            data.company =
                                $('[data-automation-id*="employer"], [data-testid*="employer"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[class*="company"], .company, .employer').first().text().trim() ||
                                null;
                        }

                        const bodyText = cleanText($.root().html());

                        if (!data.company && bodyText.includes('Om arbeidsgiveren')) {
                            // Infer from "Om arbeidsgiveren <Employer> søker ..."
                            const m = bodyText.match(
                                /Om arbeidsgiveren\s+([^#\n]+?)(?:\s+søker|\s+rekrutterer|\s+er\s)/i,
                            );
                            if (m) {
                                data.company = m[1].trim();
                            }
                        }

                        if (!data.company && fromList.company) {
                            data.company = fromList.company;
                        }

                        // Description HTML / text
                        if (!data.description_html) {
                            let descEl =
                                $('[data-automation-id*="ad-body"], [data-testid*="ad-body"]').first();

                            if (!descEl.length) {
                                descEl = $('main').first();
                            }
                            if (!descEl.length) {
                                descEl = $('article').first();
                            }
                            if (!descEl.length) {
                                descEl = $('body').first();
                            }

                            if (descEl && descEl.length) {
                                data.description_html = String(descEl.html() || '').trim() || null;
                            }
                        }

                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // Location – JSON → selectors → list
                        if (!data.location) {
                            data.location =
                                $('[data-automation-id="job-location"], [class*="location"], .location')
                                    .first()
                                    .text()
                                    .trim() || null;
                        }
                        if (!data.location && fromList.location) {
                            data.location = fromList.location;
                        }

                        // Date posted – JSON → list → textual patterns
                        if (!data.date_posted) {
                            if (fromList.date_posted) {
                                data.date_posted = fromList.date_posted;
                            } else {
                                const deadlineMatch = bodyText.match(/Frist\s+([0-9.\- ]{8,})/i);
                                const changedMatch = bodyText.match(
                                    /Sist endret\s+([0-9.\-,: ]{8,})/i,
                                );
                                if (deadlineMatch) {
                                    data.date_posted = deadlineMatch[1].trim();
                                } else if (changedMatch) {
                                    data.date_posted = changedMatch[1].trim();
                                }
                            }
                        }

                        // Category – try to derive from "Bransje" + "Stillingsfunksjon"
                        let derivedCategory = null;
                        if (bodyText) {
                            let bransje = null;
                            let stilling = null;

                            const bransjeMatch = bodyText.match(/Bransje:\s*([^\n#]+)/i);
                            if (bransjeMatch) {
                                bransje = bransjeMatch[1].trim();
                            }
                            const stillingMatch = bodyText.match(/Stillingsfunksjon:\s*([^\n#]+)/i);
                            if (stillingMatch) {
                                stilling = stillingMatch[1].trim();
                            }

                            if (bransje || stilling) {
                                derivedCategory = [bransje, stilling]
                                    .filter(Boolean)
                                    .join(' | ');
                            }
                        }

                        const finalCategory = derivedCategory || INPUT_CATEGORY || null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: finalCategory,
                            location: data.location || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: key,
                            _source: 'finn.no',
                        };

                        await Dataset.pushData(item);
                        saved++;

                        if (!item.description_html || !item.company || !item.date_posted) {
                            crawlerLog.debug(
                                `DETAIL missing fields for ${key} (company: ${!!item.company}, date_posted: ${!!item.date_posted}, description_html: ${!!item.description_html})`,
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
