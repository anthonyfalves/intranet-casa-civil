import express from "express";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const HEALTH_TIMEOUT = 5000;
const HEALTH_CACHE_MS = 60_000; // 1 min de cache para aliviar carga

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONT_ROOT = path.join(__dirname, "..", "frontend");

let cachedLinks = null;
let healthCache = new Map(); // id -> { status, ts }

async function loadLinks() {
  if (cachedLinks) return cachedLinks;
  const raw = await readFile(new URL("./data/links.json", import.meta.url), "utf-8");
  cachedLinks = JSON.parse(raw);
  return cachedLinks;
}

async function fetchHealthUrl(url, timeout = HEALTH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json,text/plain" },
      signal: controller.signal
    });
    if (!res.ok) return false;

    // tenta interpretar o corpo; considera online apenas se conteúdo indica saúde
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await res.json().catch(() => null);
      return json && (json.status === "ok" || json.healthy === true) ? true : false;
    }

    const text = (await res.text()).trim().toLowerCase();
    return text === "ok" || text === "healthy" || text.includes("status: ok");
  } catch {
    // falha de rede/timeout = inconclusivo
    return null;
  } finally {
    clearTimeout(id);
  }
}

async function checkTargets(targets) {
  const now = Date.now();
  const statuses = {};
  for (const item of targets) {
    const url = item.checkUrl || item.href;
    if (!url || url === "#") {
      statuses[item.id] = "unknown";
      continue;
    }
    const cached = healthCache.get(item.id);
    if (cached && now - cached.ts < HEALTH_CACHE_MS) {
      statuses[item.id] = cached.status;
      continue;
    }
    const ok = await fetchHealthUrl(url);
    const status = ok === true ? "online" : ok === false ? "offline" : "unknown";
    healthCache.set(item.id, { status, ts: now });
    statuses[item.id] = status;
  }
  return statuses;
}

app.use(express.static(FRONT_ROOT, { extensions: ["html"] }));

app.get("/api/links", async (_req, res) => {
  try {
    const links = await loadLinks();
    res.json(links);
  } catch (err) {
    res.status(500).json({ error: "failed_to_load_links", details: err?.message });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    const { corporateSystems } = await loadLinks();
    const statuses = await checkTargets(corporateSystems);
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: "health_check_failed", details: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`Intranet server running at http://localhost:${PORT}`);
});
