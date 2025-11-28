// Finn.no jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
            cookies, cookiesJson, dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.finn.no') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.finn.no/job/search');
            if (kw) u.searchParams.set('q', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            // category not directly supported, kept for future mapping
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenListUrls = new Set();
        const seenDetailUrls = new Set();

        const cookieHeaderFromJson = (() => {
            if (!cookiesJson) return null;
            try {
                const parsed = JSON.parse(cookiesJson);
                if (Array.isArray(parsed)) {
                    return parsed.map(c => `${c.name}=${c.value}`).join('; ');
                }
                if (parsed && typeof parsed === 'object') {
                    return Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('; ');
                }
            } catch (e) {
                log.warning(`Failed to parse cookiesJson: ${e.message}`);
            }
            return null;
        })();

        const cookieHeader = cookies || cookieHeaderFromJson || null;

        const normalizeJob = (job) => ({
            url: job?.canonical_url || job?.url || job?.id ? `https://www.finn.no/job/ad/${job.id}` : null,
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
                const title = ($(link).text() || article.find('h1,h2,h3').first().text() || '').trim();

                const metaText = (article.find('.text-xs, time, .sf-search-ad__meta').first().text() || '').replace(/\s+/g, ' ').trim();
                let date_posted = null;
                let locationGuess = null;
                if (metaText.includes('|')) {
                    const parts = metaText.split('|').map(s => s.trim()).filter(Boolean);
                    if (parts.length) date_posted = parts[0] || null;
                    if (parts.length > 1) locationGuess = parts[1] || null;
                }

                const company = (
                    article.find('[data-automation-id="search-result-company"]').first().text()
                    || article.find('.flex.flex-col.text-xs span').first().text()
                    || article.find('[class*="company"], .company, .employer').first().text()
                    || ''
                ).trim() || null;

                const location = (
                    locationGuess
                    || article.find('[data-automation-id="search-result-location"]').first().text()
                    || article.find('[class*="location"], .location').first().text()
                    || ''
                ).trim() || null;

                jobs.push({
                    url: urlAbs,
                    title: title || null,
                    company: company || null,
                    location: location || null,
                    date_posted: date_posted || null,
                });
            });
            return jobs;
        }

        function extractJobDetailsFromJson($) {
            let job = null;
            $('script').each((_, script) => {
                const content = $(script).html() || '';
                const match = content.match(/jobAd\s*[:=]\s*(\{.*?\})/s);
                if (match) {
                    try {
                        job = JSON.parse(match[1]);
                    } catch (e) { /* ignore */ }
                }
            });
            if (job) {
                return {
                    title: job.heading || job.jobTitle,
                    company: job.company?.name,
                    date_posted: job.published,
                    description_html: job.description,
                    location: job.location?.postalName || job.location?.streetAddress,
                };
            }
            return null;
        }

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            const candidates = [];

            const collect = (obj) => {
                if (!obj) return;
                if (Array.isArray(obj)) { obj.forEach(collect); return; }
                if (obj['script:ld+json']) { collect(obj['script:ld+json']); }
                if (obj.jobPosting) { collect(obj.jobPosting); }
                if (obj['@graph']) { collect(obj['@graph']); }
                const t = obj['@type'] || obj.type;
                if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) candidates.push(obj);
            };

            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    collect(parsed);
                } catch (e) { /* ignore parsing errors */ }
            }

            if (!candidates.length) return null;
            const e = candidates[0];
            return {
                title: e.title || e.name || null,
                company: e.hiringOrganization?.name || e.hiringOrganization || null,
                date_posted: e.datePosted || e.datePublished || null,
                description_html: e.description || null,
                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion || e.jobLocation.address.addressCountry)) || e.jobLocation?.addressLocality || null,
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
                    request.headers['user-agent'] = request.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
                    if (cookieHeader) request.headers.Cookie = cookieHeader;
                }
            ],
            async requestHandler({ request, response, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                let jobs = [];
                if (response.headers['content-type']?.includes('json')) {
                    try {
                        const data = JSON.parse(response.body);
                        const rawJobs = Array.isArray(data) ? data : data.jobs || [];
                        jobs = rawJobs.map(normalizeJob);
                    } catch (e) {
                        crawlerLog.error(`Failed to parse JSON: ${e.message}`);
                        return;
                    }
                } else {
                    jobs = extractJobsFromHtml($);
                }

                if (label === 'LIST') {
                    const remaining = RESULTS_WANTED - saved;
                    const uniqueJobs = jobs.filter(j => {
                        if (!j.url) return false;
                        const key = j.url.split('?')[0];
                        if (dedupe && seenListUrls.has(key)) return false;
                        if (dedupe) seenListUrls.add(key);
                        return true;
                    });

                    crawlerLog.info(`LIST page ${pageNo} -> found ${uniqueJobs.length} new jobs (remaining ${remaining})`);

                    if (collectDetails) {
                        const toEnqueue = uniqueJobs.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            await enqueueLinks({ urls: toEnqueue.map(j => j.url), userData: { label: 'DETAIL' } });
                        }
                    } else {
                        const toPush = uniqueJobs.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            await Dataset.pushData(toPush.map(j => ({ ...j, _source: 'finn.no' })));
                            saved += toPush.length;
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
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
                            await enqueueLinks({ urls: [nextUrl], userData: { label: 'LIST', pageNo: nextPageNo } });
                        }
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const key = request.url.split('?')[0];
                        if (dedupe && seenDetailUrls.has(key)) return;
                        if (dedupe) seenDetailUrls.add(key);

                        const json = extractJobDetailsFromJson($) || extractFromJsonLd($);
                        const data = json || {};
                        if (!data.title) data.title = $('h1').first().text().trim() || null;
                        if (!data.company) data.company = $('[class*="company"], .company, .employer, [itemprop="hiringOrganization"]').first().text().trim() || $('p').filter((_, el) => $(el).text().trim()).first().text().trim() || null;
                        if (!data.description_html) {
                            const desc = $('[class*="job-description"], .job-description, .description, .entry-content, [data-automation-id="job-description"], .import-decoration').first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        if (!data.location) data.location = $('[data-automation-id="job-location"], [class*="location"], .location').first().text().trim() || null;
                        if (!data.date_posted) data.date_posted = $('time').first().attr('datetime') || $('time').first().text().trim() || null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: category || null,
                            location: data.location || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: toAbs(u), userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
