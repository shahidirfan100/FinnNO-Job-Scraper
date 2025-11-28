# Finn.no Jobs Scraper

This Apify actor scrapes job listings from Finn.no using Crawlee's CheerioCrawler and gotScraping.

## Features

- Scrapes Finn.no search results (`/job/search`) and job detail pages without a browser.
- Parses list cards directly (class `sf-search-ad-link`), with JSON/JSON-LD fallbacks on detail pages.
- Handles pagination by iterating `?page=N` until the requested number of results is reached or `max_pages` is hit.
- Optional detail scraping mode to fetch full job descriptions; list-only mode for speed.
- In-memory URL deduplication to avoid duplicate dataset items across list/detail pages.
- Saves results to an Apify dataset using a consistent schema.

## Input

The actor accepts the following input fields (all optional unless noted):

- `keyword` (string) — Job title or skill to search for (in Norwegian). If omitted, fetches general listings.
- `location` (string) — Location filter (e.g., "Oslo").
- `category` (string) — Job category (not directly supported, kept for consistency).
- `startUrl` / `url` / `startUrls` — Specific Finn.no search URL(s) to start from (e.g., `https://www.finn.no/job/search?q=utvikler`). Overrides keyword/location.
- `results_wanted` (integer) — Maximum number of job listings to collect. Default: 100.
- `max_pages` (integer) — Safety cap on number of listing pages to visit. Default: 20.
- `collectDetails` (boolean) — If true, the actor will visit each job detail page to extract full description. Default: true.
- `cookies` / `cookiesJson` — Optional cookies to include in requests (helps bypass consent banner).
- `dedupe` (boolean) — In-memory deduplication of URLs. Default: true.
- `proxyConfiguration` — Proxy settings (use Apify Proxy for best results).

## Output

Each item saved to the dataset follows this structure:

```
{
	"title": "...",
	"company": "...",
	"category": "...",
	"location": "...",
	"date_posted": "...",
	"description_html": "<p>...</p>",
	"description_text": "Plain text version of description",
	"url": "..."
}
```

## Notes

- The actor uses CheerioCrawler with gotScraping; no additional local packages are required beyond those in package.json.
- On Apify platform, provide `proxyConfiguration` and reasonable `results_wanted` to avoid rate limits.
- If Finn.no changes their markup or JSON structure, selectors in `src/main.js` may need small updates.
