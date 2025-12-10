import express from "express";
import { readFile } from "fs/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import xlsx from "xlsx";

const app = express();
const PORT = process.env.PORT || 3000;
const HEALTH_TIMEOUT = 5000;
const HEALTH_CACHE_MS = 60_000; // 1 min de cache para aliviar carga
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme";
const UPLOAD_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_EXT = ["csv", "xls", "xlsx", "json"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONT_ROOT = path.join(__dirname, "..", "frontend");
// pasta centralizada para os "dados" (ex.: aniversariantes)
const DATA_DIR = path.join(__dirname, "database", "birthdays");

let cachedLinks = null;
let healthCache = new Map(); // id -> { status, ts }
let cachedBirthdays = null;

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

async function fetchHealthUrl(url, timeout = HEALTH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
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
      ok = await fetchHealthUrl(fallback);
    }
    const status = ok === true ? "online" : ok === false ? "offline" : "unknown";
    healthCache.set(item.id, { status, ts: now });
    statuses[item.id] = status;
  }
  return statuses;
}

app.use(express.static(FRONT_ROOT, { extensions: ["html"] }));

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

function authAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
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
    const name = sanitizeName(item.name || item.nome || item.colaborador);
    const dept = sanitizeName(item.dept || item.setor || item.departamento || item.lotacao);
    if (!date || !name) continue;
    result.push({ date, name, dept: dept || undefined });
  }
  return result;
}

// Temporariamente sem token para facilitar teste; reative authAdmin depois
app.post("/api/admin/birthdays/upload", upload.single("file"), async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Intranet server running at http://localhost:${PORT}`);
});
