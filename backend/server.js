import express from "express";
import { readFile } from "fs/promises";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import xlsx from "xlsx";

const app = express();
const PORT = process.env.PORT || 3000;
const HEALTH_TIMEOUT = 4000;
const HEALTH_SLOW_MS = Number(process.env.HEALTH_SLOW_MS) || 1500;
const HEALTH_CACHE_MS = 60_000; // 1 min de cache para aliviar carga
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme";
const UPLOAD_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_EXT = ["csv", "xls", "xlsx", "json"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONT_ROOT = path.join(__dirname, "..", "frontend");
// pasta centralizada para os "dados" (ex.: aniversariantes)
const DATA_DIR = path.join(__dirname, "database", "birthdays");
const BANNER_DIR = path.join(DATA_DIR, "banners");
const BANNER_META_PATH = path.join(BANNER_DIR, "banner.json");
const ALLOWED_BANNER_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const BANNER_MAX = 10;

let cachedLinks = null;
let healthCache = new Map(); // id -> { status, ts, details }
let cachedBirthdays = null;
let cachedBanner = null;

app.use(express.json({ limit: "1mb" }));

function bannerFileExists(filename) {
  if (!filename) return false;
  const filePath = path.join(BANNER_DIR, filename);
  return fs.existsSync(filePath);
}

async function persistBanners(list) {
  await fs.promises.mkdir(BANNER_DIR, { recursive: true });
  await fs.promises.writeFile(BANNER_META_PATH, JSON.stringify(list, null, 2), "utf-8");
}

async function loadLinks() {
  if (cachedLinks) return cachedLinks;
  const raw = await readFile(new URL("./data/links.json", import.meta.url), "utf-8");
  cachedLinks = JSON.parse(raw);
  return cachedLinks;
}

async function loadBirthdays() {
  if (cachedBirthdays) return cachedBirthdays;
  try {
    const raw = await readFile(new URL("./database/birthdays/birthdays.json", import.meta.url), "utf-8");
    cachedBirthdays = JSON.parse(raw);
    return cachedBirthdays;
  } catch {
    cachedBirthdays = [];
    return cachedBirthdays;
  }
}

async function loadBanner() {
  if (cachedBanner) return cachedBanner;
  try {
    const raw = await readFile(BANNER_META_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    let list = [];
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && parsed.url) {
      list = [parsed];
    }
    const filtered = list.filter((item) => bannerFileExists(item?.filename));
    if (filtered.length !== list.length) {
      await persistBanners(filtered);
    }
    cachedBanner = filtered;
    return filtered;
  } catch {
    cachedBanner = [];
    return [];
  }
}

function shouldUseOrigin(parsed) {
  const path = (parsed.pathname || "").toLowerCase();
  const hasOidcPath = path.includes("/openid-connect/auth") || path.includes("/protocol/openid-connect/auth");
  const hasLoginParams = ["state", "nonce", "code"].some((key) => parsed.searchParams.has(key));
  return hasOidcPath || hasLoginParams;
}

function buildCheckUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(String(rawUrl));
    // URLs de login/OIDC costumam redirecionar e falhar; reduzimos ao origin.
    if (shouldUseOrigin(parsed)) return `${parsed.origin}/`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

async function oneTry(url, timeout = HEALTH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });
    // Considera online se resposta < 500 (inclui 3xx/4xx comuns como 403/401)
    const ok = res.status < 500;
    return { ok, ms: Date.now() - startedAt };
  } catch {
    return { ok: false, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(id);
  }
}

async function fetchHealthUrl(url) {
  // Faz 3 tentativas para detectar instabilidade intermitente.
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(await oneTry(url));
  }

  const success = results.filter((item) => item.ok).length;
  const latencies = results.filter((item) => item.ok).map((item) => item.ms);
  const medianMs = median(latencies);

  let status = "down";
  if (success === 3) {
    status = medianMs !== null && medianMs >= HEALTH_SLOW_MS ? "unstable" : "up";
  } else if (success > 0) {
    status = "unstable";
  }

  return {
    status,
    attempts: 3,
    success,
    medianMs
  };
}

function tcpProbeUrl(url, timeout = HEALTH_TIMEOUT) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, ms: 0 });
      return;
    }

    const hostname = parsed.hostname;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "http:"
        ? 80
        : 443;

    const startedAt = Date.now();
    const socket = net.connect({ host: hostname, port });

    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, ms: Date.now() - startedAt });
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function checkTargets(targets) {
  const now = Date.now();
  const statuses = {};
  const details = {};
  for (const item of targets) {
    const primary =
      item.checkUrl && String(item.checkUrl).trim()
        ? item.checkUrl
        : item.href;
    const normalizedUrl = buildCheckUrl(primary);

    if (!normalizedUrl || primary === "#") {
      statuses[item.id] = "unknown";
      continue;
    }
    const cached = healthCache.get(item.id);
    if (cached && now - cached.ts < HEALTH_CACHE_MS) {
      statuses[item.id] = cached.status;
      if (cached.details) details[item.id] = cached.details;
      continue;
    }
    let result = await fetchHealthUrl(normalizedUrl);
    if (result.success === 0) {
      const probe = await tcpProbeUrl(normalizedUrl);
      if (probe.ok) {
        result = { ...result, status: "unstable", tcpOk: true, tcpMs: probe.ms };
      } else {
        result = { ...result, tcpOk: false, tcpMs: probe.ms };
      }
    }
    const status =
      result.status === "up"
        ? "online"
        : result.status === "down"
          ? "offline"
          : "unstable";
    healthCache.set(item.id, { status, ts: now, details: result });
    statuses[item.id] = status;
    details[item.id] = result;
  }
  if (Object.keys(details).length) {
    statuses._details = details;
  }
  return statuses;
}

app.use(express.static(FRONT_ROOT, { extensions: ["html"] }));
// expõe uploads de imagens
app.use("/uploads", express.static(path.join(__dirname, "database")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_SIZE }
});

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

app.get("/api/birthdays", async (_req, res) => {
  try {
    const list = await loadBirthdays();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "birthdays_load_failed", details: err?.message });
  }
});

app.get("/api/birthdays/banner", async (_req, res) => {
  try {
    const list = await loadBanner();
    res.json({ banners: list || [] });
  } catch (err) {
    res.status(500).json({ error: "banner_load_failed", details: err?.message });
  }
});

function authAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function isSafeBannerFilename(filename) {
  if (!filename) return false;
  const base = path.basename(String(filename));
  if (base !== filename) return false;
  const ext = (base.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_BANNER_EXT.includes(ext)) return false;
  return /^banner-\d+\.[a-z0-9]+$/i.test(base);
}

function normalizeDate(value) {
  if (!value) return null;
  const v = String(value).trim().replace(/[-.]/g, "/");
  const parts = v.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  let day;
  let month;

  if (parts.length === 3 && (parts[0].length === 4 || Number(parts[0]) > 31)) {
    // Formato ISO ou com ano na frente: YYYY/MM/DD
    [/*year*/, month, day] = parts;
  } else {
    // Formato DD/MM ou DD/MM/YYYY
    [day, month] = parts;
  }

  day = String(day).padStart(2, "0");
  month = String(month).padStart(2, "0");
  if (Number(day) < 1 || Number(day) > 31) return null;
  if (Number(month) < 1 || Number(month) > 12) return null;
  return `${day}/${month}`;
}

function sanitizeName(name) {
  return String(name || "").trim();
}

function parseCsv(buffer) {
  const text = buffer.toString("utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep);
  const rows = lines.slice(1);
  return rows.map((line) => {
    const cols = line.split(sep);
    const record = {};
    header.forEach((h, idx) => {
      record[h.trim().toLowerCase()] = cols[idx]?.trim();
    });
    return record;
  });
}

function parseXlsx(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function normalizeRecords(list) {
  const result = [];
  for (const item of list) {
    const dateRaw =
      item.date ||
      item.data ||
      item.dia ||
      item.aniversario ||
      item.birthday ||
      item.nascimento ||
      item["data de nascimento"] ||
      item["dt nascimento"];
    const date = normalizeDate(dateRaw);
    const name = sanitizeName(
      item.name ||
        item.nome ||
        item.colaborador ||
        item["nome completo"] // ex.: CSV com cabeçalho "Nome Completo"
    );
    const dept = sanitizeName(item.dept || item.setor || item.departamento || item.lotacao);
    if (!date || !name) continue;
    result.push({ date, name, dept: dept || undefined });
  }
  return result;
}

async function removeOldBanners(listToRemove) {
  if (!Array.isArray(listToRemove) || !listToRemove.length) return;
  await Promise.all(
    listToRemove.map(async (item) => {
      const oldPath = path.join(BANNER_DIR, item.filename);
      try {
        await fs.promises.unlink(oldPath);
      } catch {
        // se o arquivo nao existir, segue sem erro
      }
    })
  );
}

app.post("/api/admin/birthdays/upload", authAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file_required" });
    const ext = (req.file.originalname.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return res.status(400).json({ error: "unsupported_extension", allowed: ALLOWED_EXT });
    }

    let rawRecords = [];
    if (ext === "csv") {
      rawRecords = parseCsv(req.file.buffer);
    } else if (ext === "json") {
      rawRecords = JSON.parse(req.file.buffer.toString("utf-8"));
    } else {
      rawRecords = parseXlsx(req.file.buffer);
    }

    const normalized = normalizeRecords(rawRecords);
    if (!normalized.length) {
      return res.status(400).json({ error: "no_valid_records" });
    }

    const outputPath = path.join(DATA_DIR, "birthdays.json");
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(outputPath, JSON.stringify(normalized, null, 2), "utf-8");
    cachedBirthdays = normalized;
    res.json({ saved: normalized.length });
  } catch (err) {
    res.status(500).json({ error: "upload_failed", details: err?.message });
  }
});

app.post("/api/admin/birthdays/banner", authAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file_required" });
    const ext = (req.file.originalname.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_BANNER_EXT.includes(ext)) {
      return res.status(400).json({ error: "unsupported_extension", allowed: ALLOWED_BANNER_EXT });
    }

    await fs.promises.mkdir(BANNER_DIR, { recursive: true });
    const filename = `banner-${Date.now()}.${ext}`;
    const filePath = path.join(BANNER_DIR, filename);
    const previous = await loadBanner();

    await fs.promises.writeFile(filePath, req.file.buffer);
    const publicUrl = `/uploads/birthdays/banners/${filename}`;
    const newEntry = { url: publicUrl, filename, uploadedAt: Date.now() };
    const merged = [newEntry, ...(previous || [])].sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    const toKeep = merged.slice(0, BANNER_MAX);
    const toRemove = merged.slice(BANNER_MAX);
    await removeOldBanners(toRemove);

    await persistBanners(toKeep);
    cachedBanner = toKeep;

    res.json({ url: publicUrl, banners: toKeep });
  } catch (err) {
    res.status(500).json({ error: "banner_upload_failed", details: err?.message });
  }
});

app.get("/api/admin/birthdays/banners", authAdmin, async (_req, res) => {
  try {
    const list = await loadBanner();
    res.json({ banners: list || [] });
  } catch (err) {
    res.status(500).json({ error: "banner_list_failed", details: err?.message });
  }
});

app.post("/api/admin/birthdays/banners/delete", authAdmin, async (req, res) => {
  try {
    const filenames = req.body?.filenames;
    if (!Array.isArray(filenames) || !filenames.length) {
      return res.status(400).json({ error: "filenames_required" });
    }

    const requested = [...new Set(filenames.map((f) => String(f)))].filter(isSafeBannerFilename);
    if (!requested.length) {
      return res.status(400).json({ error: "no_valid_filenames" });
    }

    const previous = await loadBanner();
    const toRemove = previous.filter((item) => requested.includes(item.filename));
    const toKeep = previous.filter((item) => !requested.includes(item.filename));

    await removeOldBanners(toRemove);
    await persistBanners(toKeep);
    cachedBanner = toKeep;

    res.json({ removed: toRemove.map((i) => i.filename), banners: toKeep });
  } catch (err) {
    res.status(500).json({ error: "banner_delete_failed", details: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`Intranet server running at http://localhost:${PORT}`);
});
