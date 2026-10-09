(() => {
    "use strict";

    const API_TIMEOUT_MS = 14000;
    const MAX_RETRIES = 2;
    const elements = {
        urls: document.getElementById("urls"),
        file: document.getElementById("file-input"),
        urlCount: document.getElementById("url-count"),
        check: document.getElementById("check-button"),
        clear: document.getElementById("clear-button"),
        cancel: document.getElementById("cancel-button"),
        concurrency: document.getElementById("concurrency-select"),
        inputError: document.getElementById("input-error"),
        progressSection: document.getElementById("progress-section"),
        progressLabel: document.getElementById("progress-label"),
        progressPercentage: document.getElementById("progress-percentage"),
        progressDetail: document.getElementById("progress-detail"),
        progressBar: document.getElementById("progress-bar"),
        progressTrack: document.querySelector('[role="progressbar"]'),
        results: document.getElementById("results-section"),
        body: document.getElementById("results-body"),
        empty: document.getElementById("empty-results"),
        search: document.getElementById("search-input"),
        filter: document.getElementById("status-filter"),
        toast: document.getElementById("toast")
    };

    let results = [];
    let running = false;
    let controller = null;
    let sortKey = "number";
    let sortDirection = 1;
    let toastTimer = null;

    function parseLines(text) {
        return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }

    function parseCsv(text) {
        const rows = [];
        let row = [];
        let cell = "";
        let quoted = false;
        for (let i = 0; i < text.length; i += 1) {
            const character = text[i];
            if (quoted && character === '"' && text[i + 1] === '"') {
                cell += '"';
                i += 1;
            } else if (character === '"') {
                quoted = !quoted;
            } else if (character === "," && !quoted) {
                row.push(cell.trim());
                cell = "";
            } else if ((character === "\n" || character === "\r") && !quoted) {
                if (character === "\r" && text[i + 1] === "\n") i += 1;
                row.push(cell.trim());
                if (row.some(Boolean)) rows.push(row);
                row = [];
                cell = "";
            } else {
                cell += character;
            }
        }
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);

        const urls = [];
        for (const csvRow of rows) {
            for (const value of csvRow) {
                if (/^https?:\/\//i.test(value)) urls.push(value);
            }
        }
        return urls;
    }

    function updateUrlCount() {
        const count = parseLines(elements.urls.value).length;
        elements.urlCount.textContent = `${count.toLocaleString()} ${count === 1 ? "URL" : "URLs"}`;
    }

    function getArticleId(value) {
        try {
            const url = new URL(value);
            if (url.protocol !== "http:" && url.protocol !== "https:") return null;
            const match = url.pathname.match(/(\d+)(?:\.html)?\/?$/i);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    function setInputError(message) {
        elements.inputError.textContent = message;
        elements.inputError.hidden = !message;
    }

    function updateProgress(completed, total, state) {
        const percentage = total === 0 ? 0 : Math.floor(completed / total * 100);
        elements.progressLabel.textContent = state === "cancelled" ? "Checking cancelled" :
            state === "complete" ? "Checking complete" : "Checking article metadata…";
        elements.progressPercentage.textContent = `${percentage}%`;
        elements.progressDetail.textContent = `${completed.toLocaleString()} / ${total.toLocaleString()} checked`;
        elements.progressBar.style.width = `${percentage}%`;
        elements.progressTrack.setAttribute("aria-valuenow", String(percentage));
    }

    function getClassifiedStatus(data) {
        const metadata = data && typeof data === "object" ? data.metadata : null;
        if (!metadata || typeof metadata !== "object") {
            return { status: "UNKNOWN / UNVERIFIED", detail: "metadata object missing from API response" };
        }
        const articleStatus = typeof metadata.status === "string" ? ` · status=${metadata.status}` : "";
        if (metadata.killed === true) return { status: "KILLED", detail: `metadata.killed=true${articleStatus}` };
        if (metadata.killed === false) return { status: "NOT KILLED", detail: `metadata.killed=false${articleStatus}` };
        const fields = Object.keys(metadata).slice(0, 12).join(", ");
        return {
            status: "UNKNOWN / UNVERIFIED",
            detail: `metadata.killed missing or is not a Boolean${fields ? ` · available metadata: ${fields}` : ""}`
        };
    }

    async function requestArticle(id, signal) {
        let lastError;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
            if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
            const timeoutController = new AbortController();
            const timeout = setTimeout(() => timeoutController.abort(), API_TIMEOUT_MS);
            const abortRequest = () => timeoutController.abort();
            signal.addEventListener("abort", abortRequest, { once: true });
            try {
                const response = await fetch(`/api/articles/${encodeURIComponent(id)}`, { signal: timeoutController.signal });
                const payload = await response.json().catch(() => null);
                if (!response.ok) {
                    const message = payload && payload.error ? payload.error : `Proxy returned HTTP ${response.status}`;
                    const error = new Error(message);
                    error.status = response.status;
                    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
                    error.detail = payload && payload.details ? payload.details : "";
                    throw error;
                }
                const upstreamStatus = payload && payload.upstreamStatus;
                if (typeof upstreamStatus === "number" && (upstreamStatus === 408 || upstreamStatus === 429 || upstreamStatus >= 500)) {
                    const error = new Error(payload.error || `HT API returned HTTP ${upstreamStatus}`);
                    error.status = upstreamStatus;
                    error.retryable = true;
                    error.detail = payload.details || "";
                    throw error;
                }
                if (typeof upstreamStatus === "number" && upstreamStatus >= 400) {
                    const error = new Error(payload.error || `HT API returned HTTP ${upstreamStatus}`);
                    error.status = upstreamStatus;
                    error.retryable = false;
                    error.detail = payload.details || "";
                    throw error;
                }
                return payload;
            } catch (error) {
                if (signal.aborted || error.name === "AbortError" && !timeoutController.signal.aborted) {
                    throw new DOMException("Request cancelled", "AbortError");
                }
                const timedOut = timeoutController.signal.aborted && !signal.aborted;
                lastError = timedOut ? Object.assign(new Error(`Request timed out after ${API_TIMEOUT_MS / 1000} seconds`), { retryable: true }) : error;
                if (error.name === "AbortError" && timedOut) {
                    lastError = Object.assign(new Error(`Request timed out after ${API_TIMEOUT_MS / 1000} seconds`), { retryable: true });
                }
                if (attempt < MAX_RETRIES && lastError.retryable !== false && (lastError.retryable === true || !lastError.status)) {
                    await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            clearTimeout(retryTimer);
                            reject(new DOMException("Request cancelled", "AbortError"));
                        };
                        const retryTimer = setTimeout(() => {
                            signal.removeEventListener("abort", onAbort);
                            resolve();
                        }, 350 * (attempt + 1));
                        signal.addEventListener("abort", onAbort, { once: true });
                    });
                } else {
                    break;
                }
            } finally {
                clearTimeout(timeout);
                signal.removeEventListener("abort", abortRequest);
            }
        }
        throw lastError;
    }

    async function checkUniqueId(id, signal) {
        try {
            const payload = await requestArticle(id, signal);
            const classified = getClassifiedStatus(payload ? payload.data : null);
            const detail = classified.status === "UNKNOWN / UNVERIFIED" && payload && payload.details
                ? `${classified.detail} · Response: ${payload.details}`
                : payload && payload.upstreamStatus
                    ? `HTTP ${payload.upstreamStatus} · ${classified.detail}`
                    : classified.detail;
            return { status: classified.status, detail };
        } catch (error) {
            if (error.name === "AbortError") throw error;
            const status = error.status && !error.message.includes(`HTTP ${error.status}`) ? `HTTP ${error.status}: ` : "";
            return { status: "API ERROR", detail: `${status}${error.message}${error.detail ? ` · ${error.detail}` : ""}` };
        }
    }

    async function runWorkers(ids, concurrency, worker) {
        let next = 0;
        const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
            while (next < ids.length && !controller.signal.aborted) {
                const index = next;
                next += 1;
                await worker(ids[index]);
            }
        });
        await Promise.all(workers);
    }

    async function checkArticles() {
        const submitted = parseLines(elements.urls.value);
        setInputError("");
        if (!submitted.length) {
            setInputError("Add at least one article URL or upload a CSV/TXT file before checking.");
            return;
        }

        results = submitted.map((url, index) => {
            const id = getArticleId(url);
            return {
                number: index + 1,
                url,
                id,
                status: "UNKNOWN / UNVERIFIED",
                detail: id ? "Waiting for API response" : "Invalid URL or no numeric article ID at the end of the URL"
            };
        });
        elements.results.hidden = false;
        elements.progressSection.hidden = false;
        elements.check.disabled = true;
        elements.clear.disabled = true;
        elements.cancel.hidden = false;
        elements.search.value = "";
        elements.filter.value = "ALL";
        elements.body.replaceChildren();
        updateMetrics();
        renderResults();

        controller = new AbortController();
        running = true;
        let completed = 0;
        updateProgress(0, results.length, "running");

        const grouped = new Map();
        for (const row of results) {
            if (!row.id) {
                completed += 1;
                updateProgress(completed, results.length, "running");
                continue;
            }
            if (!grouped.has(row.id)) grouped.set(row.id, []);
            grouped.get(row.id).push(row);
        }

        try {
            const ids = Array.from(grouped.keys());
            await runWorkers(ids, Number(elements.concurrency.value), async id => {
                const outcome = await checkUniqueId(id, controller.signal);
                for (const row of grouped.get(id)) {
                    row.status = outcome.status;
                    row.detail = outcome.detail;
                }
                completed += grouped.get(id).length;
                updateProgress(completed, results.length, "running");
                updateMetrics();
                renderResults();
            });
        } catch (error) {
            if (error.name !== "AbortError") {
                setInputError(`Processing stopped unexpectedly: ${error.message}`);
            }
        } finally {
            running = false;
            elements.check.disabled = false;
            elements.clear.disabled = false;
            elements.cancel.hidden = true;
            updateMetrics();
            renderResults();
            updateProgress(completed, results.length, controller.signal.aborted ? "cancelled" : "complete");
        }
    }

    function updateMetrics() {
        const count = status => results.filter(row => row.status === status).length;
        const killed = count("KILLED");
        const notKilled = count("NOT KILLED");
        const classified = killed + notKilled;
        document.getElementById("metric-total").textContent = results.length.toLocaleString();
        document.getElementById("metric-checked").textContent = results.filter(row =>
            row.id && row.status !== "API ERROR" && row.detail !== "Waiting for API response"
        ).length.toLocaleString();
        document.getElementById("metric-killed").textContent = killed.toLocaleString();
        document.getElementById("metric-not-killed").textContent = notKilled.toLocaleString();
        document.getElementById("metric-unknown").textContent = count("UNKNOWN / UNVERIFIED").toLocaleString();
        document.getElementById("metric-errors").textContent = count("API ERROR").toLocaleString();
        document.getElementById("metric-percentage").textContent = `${classified ? (killed / classified * 100).toFixed(1) : "0"}%`;
    }

    function statusClass(status) {
        if (status === "KILLED") return "badge-killed";
        if (status === "NOT KILLED") return "badge-alive";
        if (status === "API ERROR") return "badge-error";
        return "badge-unknown";
    }

    function renderResults() {
        const query = elements.search.value.trim().toLowerCase();
        const selectedStatus = elements.filter.value;
        const visible = results.filter(row =>
            (selectedStatus === "ALL" || row.status === selectedStatus) &&
            (!query || row.url.toLowerCase().includes(query) || (row.id || "").includes(query) || row.detail.toLowerCase().includes(query))
        );
        visible.sort((a, b) => {
            if (sortKey === "number") return (a.number - b.number) * sortDirection;
            if (sortKey === "id") return (a.id || "").localeCompare(b.id || "") * sortDirection;
            return a.status.localeCompare(b.status) * sortDirection || a.number - b.number;
        });
        const fragment = document.createDocumentFragment();
        for (const row of visible) {
            const tr = document.createElement("tr");
            const number = document.createElement("td");
            number.textContent = String(row.number).padStart(2, "0");
            const urlCell = document.createElement("td");
            let navigableUrl = false;
            try {
                const parsedUrl = new URL(row.url);
                navigableUrl = parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
            } catch {
                navigableUrl = false;
            }
            if (navigableUrl) {
                const link = document.createElement("a");
                link.className = "url-cell";
                link.href = row.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.title = row.url;
                link.textContent = row.url;
                urlCell.append(link);
            } else {
                const text = document.createElement("span");
                text.className = "url-cell";
                text.textContent = row.url;
                urlCell.append(text);
            }
            const idCell = document.createElement("td");
            idCell.className = "id-cell";
            idCell.textContent = row.id || "—";
            const statusCell = document.createElement("td");
            const badge = document.createElement("span");
            badge.className = `status-badge ${statusClass(row.status)}`;
            badge.textContent = row.status;
            statusCell.append(badge);
            const detailCell = document.createElement("td");
            const detail = document.createElement("span");
            detail.className = "response-cell";
            detail.title = row.detail;
            detail.textContent = row.detail;
            detailCell.append(detail);
            tr.append(number, urlCell, idCell, statusCell, detailCell);
            fragment.append(tr);
        }
        elements.body.replaceChildren(fragment);
        elements.empty.hidden = visible.length !== 0;
        document.getElementById("table-count").textContent = `${visible.length.toLocaleString()} ${visible.length === 1 ? "article" : "articles"}`;
    }

    function csvEscape(value) {
        const string = String(value ?? "");
        return `"${string.replace(/"/g, '""')}"`;
    }

    function downloadCsv(rows, filename) {
        const headings = ["S. No.", "Article URL", "Article ID", "Status", "API response / error details"];
        const lines = [headings, ...rows.map(row => [row.number, row.url, row.id || "", row.status, row.detail])];
        const blob = new Blob(["\uFEFF", lines.map(line => line.map(csvEscape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    function showToast(message) {
        elements.toast.textContent = message;
        elements.toast.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2400);
    }

    async function copyKilled(value) {
        const killed = results.filter(row => row.status === "KILLED").map(value);
        if (!killed.length) {
            showToast("No killed articles to copy.");
            return;
        }
        try {
            await navigator.clipboard.writeText(killed.join("\n"));
            showToast(`Copied ${killed.length} killed ${killed.length === 1 ? "article" : "articles"}.`);
        } catch (error) {
            setInputError(`Clipboard access failed: ${error.message}. Use the CSV export instead.`);
        }
    }

    elements.urls.addEventListener("input", updateUrlCount);
    elements.check.addEventListener("click", checkArticles);
    elements.clear.addEventListener("click", () => {
        if (running) return;
        elements.urls.value = "";
        elements.file.value = "";
        elements.results.hidden = true;
        elements.progressSection.hidden = true;
        elements.search.value = "";
        elements.filter.value = "ALL";
        results = [];
        setInputError("");
        updateUrlCount();
    });
    elements.file.addEventListener("change", async () => {
        const file = elements.file.files && elements.file.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const isCsv = /\.csv$/i.test(file.name) || /,/.test(text.split(/\r?\n/, 1)[0] || "");
            const urls = isCsv ? parseCsv(text) : parseLines(text);
            if (!urls.length) {
                setInputError("No URLs found in that file. Use a TXT file with one URL per line or a CSV containing URL values.");
                return;
            }
            elements.urls.value = urls.join("\n");
            setInputError("");
            updateUrlCount();
        } catch (error) {
            setInputError(`Could not read the selected file: ${error.message}`);
        }
    });
    elements.cancel.addEventListener("click", () => {
        if (controller && running) controller.abort();
    });
    elements.search.addEventListener("input", renderResults);
    elements.filter.addEventListener("change", renderResults);
    document.querySelectorAll(".sort-button").forEach(button => {
        button.addEventListener("click", () => {
            const requested = button.dataset.sort;
            sortDirection = sortKey === requested ? sortDirection * -1 : 1;
            sortKey = requested;
            document.querySelectorAll(".sort-button span").forEach(span => { span.textContent = ""; });
            button.querySelector("span").textContent = sortDirection === 1 ? "↑" : "↓";
            renderResults();
        });
    });
    document.getElementById("export-all-button").addEventListener("click", () => downloadCsv(results, "ht-articles-results.csv"));
    document.getElementById("export-killed-button").addEventListener("click", () => downloadCsv(results.filter(row => row.status === "KILLED"), "ht-killed-articles.csv"));
    document.getElementById("copy-urls-button").addEventListener("click", () => copyKilled(row => row.url));
    document.getElementById("copy-ids-button").addEventListener("click", () => copyKilled(row => row.id || ""));
    updateUrlCount();
})();
