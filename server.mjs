import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const apiBaseUrl = (process.env.HT_API_BASE_URL || "https://api.hindustantimes.com/api/articles/v3").replace(/\/+$/, "");
const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
};

function sendJson(response, statusCode, body) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
}

async function proxyArticle(id, response) {
    if (!/^\d+$/.test(id)) {
        sendJson(response, 400, { error: "Article ID must contain digits only." });
        return;
    }

    const timeout = AbortSignal.timeout(12000);
    try {
        const upstream = await fetch(`${apiBaseUrl}/${encodeURIComponent(id)}`, {
            headers: { Accept: "application/json" },
            signal: timeout
        });
        const text = await upstream.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!upstream.ok) {
            sendJson(response, 200, {
                error: `HT API returned HTTP ${upstream.status}`,
                upstreamStatus: upstream.status,
                details: text.slice(0, 1000)
            });
            return;
        }
        sendJson(response, 200, {
            upstreamStatus: upstream.status,
            data,
            details: data === null ? text.slice(0, 1000) : undefined
        });
    } catch (error) {
        const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
        sendJson(response, 502, {
            error: timedOut ? "HT API request timed out." : "Could not reach the HT API. Check network access and the configured API base URL.",
            details: error.message,
            retryable: true
        });
    }
}

async function serveStatic(urlPath, response) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        response.writeHead(400).end("Invalid URL");
        return;
    }
    const requested = decoded === "/" ? "/index.html" : decoded;
    const filePath = path.resolve(root, `.${requested}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
    }
    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) throw new Error("Not a file");
        const content = await readFile(filePath);
        response.writeHead(200, {
            "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
            "Content-Length": content.length
        });
        response.end(content);
    } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
    }
}

createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const match = url.pathname.match(/^\/api\/articles\/([^/]+)$/);
    if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" }).end();
        return;
    }
    if (match) {
        void proxyArticle(match[1], response);
        return;
    }
    void serveStatic(url.pathname, response);
}).listen(port, () => {
    console.log(`HT Killed Articles Checker running at http://localhost:${port}`);
    console.log(`HT API base URL: ${apiBaseUrl}`);
});
