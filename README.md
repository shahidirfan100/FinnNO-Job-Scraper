# Finn.no Job Scraper

Scrape job listings from Finn.no, Norway's leading classifieds site, to gather comprehensive job data including titles, companies, locations, and descriptions. This actor efficiently extracts jobs from Finn.no's search results and detail pages, making it ideal for job market analysis, recruitment, and data aggregation in the Norwegian job sector.

## Features

- **Comprehensive Job Extraction**: Collects detailed job information from Finn.no's job listings, including titles, companies, locations, posting dates, and full descriptions.
- **Flexible Search Options**: Supports keyword-based searches, location filters, and custom start URLs for targeted scraping.
- **Pagination Handling**: Automatically navigates through multiple pages of search results to collect the desired number of jobs.
- **Detail Page Scraping**: Optionally fetches full job descriptions from individual job pages for richer data.
- **Deduplication**: Ensures no duplicate job listings in the output dataset.
- **Proxy Support**: Integrates with Apify Proxy for reliable and stealthy scraping.
- **SEO-Optimized Output**: Structured data suitable for further processing, analysis, or integration with job boards.

## Input

Configure the actor with the following input parameters to customize your job scraping:

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `keyword` | string | Job search keyword (e.g., "utvikler", "ingeniør"). Use Norwegian terms for best results. | - |
| `location` | string | Location filter (e.g., "Oslo", "Bergen"). | - |
| `startUrl` / `url` / `startUrls` | string/array | Custom Finn.no job search URL(s) to start from. Overrides keyword/location if provided. | - |
| `results_wanted` | integer | Maximum number of jobs to collect. | 100 |
| `max_pages` | integer | Maximum number of search pages to visit. | 20 |
| `collectDetails` | boolean | Whether to scrape full descriptions from job detail pages. | true |
| `dedupe` | boolean | Enable in-memory deduplication of job URLs. | true |
| `proxyConfiguration` | object | Proxy settings for scraping (recommended: Apify Proxy). | - |
| `cookies` / `cookiesJson` | string | Custom cookies to bypass consent banners. | - |

All parameters are optional. Provide at least `keyword` or `location` for general searches, or use `startUrls` for specific queries.

## Output

The actor outputs a dataset of job listings in JSON format. Each item includes:

```json
{
  "title": "Job Title",
  "company": "Company Name",
  "category": "Job Category",
  "location": "Location",
  "date_posted": "Posting Date",
  "description_html": "<p>Full HTML description</p>",
  "description_text": "Plain text description",
  "url": "https://www.finn.no/job/ad/..."
}
```

- **title**: Job position title.
- **company**: Hiring company name.
- **category**: Job category (if available).
- **location**: Job location or "Remote".
- **date_posted**: Date the job was posted.
- **description_html**: Full job description in HTML.
- **description_text**: Plain text version of the description.
- **url**: Direct link to the job listing on Finn.no.

## Usage

1. **On Apify Platform**:
   - Search for "Finn.no Job Scraper" in the Apify Store.
   - Click "Run" and configure inputs as needed.
   - Monitor the run and download results from the dataset.

2. **Via API**:
   - Use the Apify API to run the actor programmatically.
   - Example API call:
     ```bash
     curl -X POST "https://api.apify.com/v2/acts/finn-no-jobs-scraper/runs" \
     -H "Authorization: Bearer YOUR_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"keyword": "utvikler", "location": "Oslo", "results_wanted": 50}'
     ```

3. **Local Development**:
   - Clone the actor and run locally with Node.js.
   - Set input via `INPUT.json` and execute `npm start`.

## Configuration

- **Proxy Settings**: For production use, enable Apify Proxy with residential IPs to avoid blocks.
- **Rate Limiting**: Adjust `max_pages` and `results_wanted` to control scraping speed and volume.
- **Cookies**: If Finn.no requires consent, provide cookies to simulate user acceptance.
- **Deduplication**: Keep `dedupe` enabled to prevent duplicate entries.

## Examples

### Example 1: Scrape Developer Jobs in Oslo
```json
{
  "keyword": "utvikler",
  "location": "Oslo",
  "results_wanted": 100,
  "collectDetails": true
}
```

### Example 2: Custom Search URL
```json
{
  "startUrls": ["https://www.finn.no/job/search?q=ingeniør&location=Trondheim"],
  "results_wanted": 50
}
```

### Example 3: Quick List-Only Scrape
```json
{
  "keyword": "analytiker",
  "collectDetails": false,
  "results_wanted": 20
}
```

## Limitations

- Scraping is subject to Finn.no's terms of service; use responsibly.
- Some jobs may require user interaction or have dynamic content not captured.
- High-volume scraping may trigger rate limits; use proxies and reasonable limits.
- Output is based on available data; missing fields are set to `null`.

## Support

For issues, feature requests, or questions:
- Check the [Apify Community Forum](https://community.apify.com/).
- Report bugs via the actor's GitHub repository.
- Contact support at support@apify.com.

---

*This actor is designed for ethical web scraping. Ensure compliance with local laws and website policies.*
