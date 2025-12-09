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
      headers: {
        // user-agent mais próximo de browser para evitar bloqueios simples
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });
    // Considera online se resposta < 500 (inclui 3xx/4xx comuns como 403/401)
    if (res.status < 500) return true;
    return false;
  } catch {
    // Falha de rede/timeout = inconclusivo
    return null;
  } finally {
    clearTimeout(id);
  }
}

async function checkTargets(targets) {
  const now = Date.now();
  const statuses = {};
  for (const item of targets) {
    const primary = item.checkUrl || item.href;
    const fallback = item.href;

    if (!primary || primary === "#") {
      statuses[item.id] = "unknown";
      continue;
    }
    const cached = healthCache.get(item.id);
    if (cached && now - cached.ts < HEALTH_CACHE_MS) {
      statuses[item.id] = cached.status;
      continue;
    }
    let ok = await fetchHealthUrl(primary);
    if (ok === false && fallback && fallback !== primary && fallback !== "#") {
      // Se a URL dedicada falhar, tenta o href como segunda chance
      ok = await fetchHealthUrl(fallback);
    }
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
