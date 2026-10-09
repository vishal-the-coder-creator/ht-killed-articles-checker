# HT Killed Articles Checker

A lightweight web utility for checking Hindustan Times article metadata in bulk. It uses a small Node.js server-side proxy so the browser does not depend on HT API CORS headers.

## Requirements

- Node.js 18 or later (the app has no npm dependencies)

## Run locally

1. In the project directory, run `npm start`.
2. Open [http://localhost:3000](http://localhost:3000).
3. Paste one article URL per line, or upload a CSV/TXT file, then select **Check articles**.

To use a different HT API base URL, set `HT_API_BASE_URL` before starting the server. The default is `https://api.hindustantimes.com/api/articles/v3`. For example, in PowerShell:

```powershell
$env:HT_API_BASE_URL = "https://api.hindustantimes.com/api/articles/v3"
npm start
```

The server listens on port 3000 by default; set `PORT` to change it. The base URL should be a trusted HT API endpoint.

## Behavior

- The article ID is read from the final numeric path segment. IDs are requested once per batch, with adjustable concurrency (5, 10, 15, or 20 simultaneous requests).
- Temporary network, timeout, HTTP 408/429, and 5xx failures are retried up to two times. Requests have a 14-second browser timeout and a 12-second proxy timeout.
- `metadata.killed` is classified only when it is the Boolean `true` or `false`. Missing or non-Boolean values are unknown; request failures are API errors.
- Invalid URLs and URLs without an article ID are shown as unknown and do not generate API requests.
- Results retain input order. Cancel stops pending requests, and duplicate IDs share one API request.
- CSV exports include each result's URL, article ID, status, and API response/error detail.

The HT API must be reachable from the machine running the Node server. HTTP/API error details are shown in the results table for troubleshooting.
