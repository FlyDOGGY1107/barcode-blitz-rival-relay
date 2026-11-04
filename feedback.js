"use strict";

// Anonymous in-game feedback for the Barcode Blitz demo (v1.6+).
//
//   POST /api/v1/feedback          the game sends four multiple-choice picks
//   GET  /feedback                 private results page (asks for the admin key)
//   GET  /api/v1/feedback/summary  vote counts for that page (x-admin-key header)
//
// Nothing personal is accepted or stored: no names, Steam IDs, free text or IP
// addresses. The client IP is only hashed in memory for a short rate limit.
//
// Storage: a free Supabase table through its REST API when SUPABASE_URL and
// SUPABASE_SERVICE_KEY are set (see feedback_table.sql). Without them, answers
// are kept in memory only and are lost when the service restarts.
//
// Environment (set these in the Render dashboard, never in the repository):
//   SUPABASE_URL          e.g. https://abcdefgh.supabase.co
//   SUPABASE_SERVICE_KEY  the project's service_role key (server-side only)
//   FEEDBACK_TABLE        optional, defaults to "feedback"
//   FEEDBACK_ADMIN_KEY    a long random password for the results page

const crypto = require("crypto");

const TOPICS = ["scanner", "pacing", "clarity", "bugs"];
const LABELS = {
  scanner: ["LOVED IT", "GOOD", "OKAY", "CLUNKY", "FRUSTRATING"],
  pacing: ["TOO EASY", "A BIT EASY", "JUST RIGHT", "A BIT HARD", "TOO HARD"],
  clarity: ["VERY CLEAR", "MOSTLY CLEAR", "SOME CONFUSION", "OFTEN CONFUSED", "LOST"],
  bugs: ["NO BUGS", "SMALL VISUAL GLITCH", "GAMEPLAY BUG", "LOST PROGRESS", "CRASH"],
};
const TITLES = { scanner: "Scanner feel", pacing: "Shift pacing", clarity: "Clarity + access", bugs: "Bug reports" };
const BUG_AREAS = new Set(["", "campaign", "wave", "rival", "menus"]);
const MAX_BODY = 2048;
const PER_IP_LIMIT = 3;
const PER_IP_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_LIMIT = 600;
const MEMORY_LIMIT = 5000;

const memoryRows = [];
const ipHits = new Map();
let globalWindowStart = Date.now();
let globalCount = 0;
const hashSalt = crypto.randomBytes(16);

function config() {
  return {
    url: String(process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: String(process.env.SUPABASE_SERVICE_KEY || ""),
    table: String(process.env.FEEDBACK_TABLE || "feedback").replace(/[^a-z0-9_]/gi, "") || "feedback",
    admin: String(process.env.FEEDBACK_ADMIN_KEY || ""),
  };
}

function usingSupabase(cfg) {
  return cfg.url.startsWith("https://") && cfg.key.length > 20;
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      // Keep draining so the client still gets a 413 answer; just stop keeping it.
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > MAX_BODY * 32) request.destroy();
    });
    request.on("end", () => {
      if (size > MAX_BODY) {
        reject(new Error("BODY_TOO_LARGE"));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (_error) { reject(new Error("BAD_JSON")); }
    });
    request.on("error", reject);
  });
}

// Returns a clean row or null. Unknown fields are ignored, never stored.
function validate(payload) {
  if (!payload || typeof payload !== "object" || payload.v !== 1) return null;
  const build = String(payload.build || "");
  if (!/^[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,3}$/.test(build)) return null;
  const answers = payload.answers;
  if (!answers || typeof answers !== "object") return null;
  const row = { build };
  let picked = 0;
  for (const topic of TOPICS) {
    const value = answers[topic];
    if (!Number.isInteger(value) || value < -1 || value > 4) return null;
    row[topic] = value;
    if (value >= 0) picked += 1;
  }
  if (picked === 0) return null;
  const area = String(payload.bug_area || "");
  if (!BUG_AREAS.has(area)) return null;
  row.bug_area = row.bugs > 0 ? area : "";
  return row;
}

function clientKey(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || request.socket.remoteAddress || "unknown";
  return crypto.createHmac("sha256", hashSalt).update(ip).digest("hex");
}

function rateAllowed(request) {
  const now = Date.now();
  if (now - globalWindowStart >= PER_IP_WINDOW_MS) {
    globalWindowStart = now;
    globalCount = 0;
    ipHits.clear();
  }
  if (globalCount >= GLOBAL_LIMIT) return false;
  const key = clientKey(request);
  const hits = (ipHits.get(key) || []).filter((time) => now - time < PER_IP_WINDOW_MS);
  if (hits.length >= PER_IP_LIMIT) {
    ipHits.set(key, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(key, hits);
  globalCount += 1;
  return true;
}

async function storeRow(row) {
  const cfg = config();
  if (!usingSupabase(cfg)) {
    memoryRows.push({ ...row, created_at: new Date().toISOString() });
    if (memoryRows.length > MEMORY_LIMIT) memoryRows.splice(0, memoryRows.length - MEMORY_LIMIT);
    return "memory";
  }
  const result = await fetch(`${cfg.url}/rest/v1/${cfg.table}`, {
    method: "POST",
    headers: {
      apikey: cfg.key,
      authorization: `Bearer ${cfg.key}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw new Error(`SUPABASE_${result.status}`);
  return "database";
}

async function loadRows() {
  const cfg = config();
  if (!usingSupabase(cfg)) return memoryRows.slice();
  const query = "select=build,scanner,pacing,clarity,bugs,bug_area,created_at&order=created_at.desc&limit=10000";
  const result = await fetch(`${cfg.url}/rest/v1/${cfg.table}?${query}`, {
    headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) throw new Error(`SUPABASE_${result.status}`);
  return result.json();
}

function summarize(rows, build) {
  const filtered = build ? rows.filter((row) => row.build === build) : rows;
  const builds = {};
  for (const row of rows) builds[row.build] = (builds[row.build] || 0) + 1;
  const topics = {};
  for (const topic of TOPICS) {
    const counts = [0, 0, 0, 0, 0];
    let skipped = 0;
    for (const row of filtered) {
      const value = Number(row[topic]);
      if (value >= 0 && value <= 4) counts[value] += 1;
      else skipped += 1;
    }
    topics[topic] = { title: TITLES[topic], labels: LABELS[topic], counts, skipped };
  }
  const areas = { campaign: 0, wave: 0, rival: 0, menus: 0 };
  for (const row of filtered) if (areas[row.bug_area] !== undefined) areas[row.bug_area] += 1;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const lastWeek = filtered.filter((row) => Date.parse(row.created_at) >= weekAgo).length;
  return { ok: true, total: filtered.length, last_7_days: lastWeek, build: build || "all", builds, topics, bug_areas: areas };
}

function adminAllowed(request) {
  const admin = config().admin;
  const given = String(request.headers["x-admin-key"] || "");
  if (admin.length < 12 || given.length !== admin.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(admin));
}

// Returns true when the request was a feedback route and has been answered.
async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "POST" && url.pathname === "/api/v1/feedback") {
    let payload;
    try {
      payload = await readBody(request);
    } catch (error) {
      json(response, error.message === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, error: error.message });
      return true;
    }
    const row = validate(payload);
    if (!row) {
      json(response, 400, { ok: false, error: "INVALID_FEEDBACK" });
      return true;
    }
    if (!rateAllowed(request)) {
      json(response, 429, { ok: false, error: "RATE_LIMITED" });
      return true;
    }
    try {
      const stored = await storeRow(row);
      json(response, 201, { ok: true, stored });
    } catch (error) {
      console.error("Feedback store failed:", error.message);
      json(response, 503, { ok: false, error: "STORE_UNAVAILABLE" });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/feedback/summary") {
    if (config().admin.length < 12) {
      json(response, 503, { ok: false, error: "DASHBOARD_DISABLED" });
      return true;
    }
    if (!adminAllowed(request)) {
      json(response, 401, { ok: false, error: "ADMIN_KEY_REQUIRED" });
      return true;
    }
    try {
      const rows = await loadRows();
      const build = String(url.searchParams.get("build") || "");
      json(response, 200, { ...summarize(rows, /^[0-9.]{1,12}$/.test(build) ? build : ""), storage: usingSupabase(config()) ? "database" : "memory" });
    } catch (error) {
      console.error("Feedback summary failed:", error.message);
      json(response, 503, { ok: false, error: "STORE_UNAVAILABLE" });
    }
    return true;
  }
  if (request.method === "GET" && (url.pathname === "/feedback" || url.pathname === "/feedback/")) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    response.end(DASHBOARD_HTML);
    return true;
  }
  return false;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Barcode Blitz Feedback</title>
<style>
:root{--bg:#2b2b29;--card:#f7f4ec;--ink:#17181a;--soft:#5b564c;--yel:#f4c430;--green:#1e8f52;--red:#d9412b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
header{background:repeating-linear-gradient(135deg,var(--yel) 0 14px,var(--ink) 14px 28px);height:10px}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{color:var(--card);margin:0 0 4px;font-size:28px;letter-spacing:.5px}.sub{color:#cfc9bc;margin:0 0 20px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
input,select,button{font:inherit;padding:9px 12px;border:3px solid var(--ink);border-radius:0}
button{background:var(--yel);font-weight:800;cursor:pointer}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--ink);color:var(--yel);padding:12px 14px}.stat b{display:block;font-size:30px}.stat span{color:#beb8aa;font-size:12px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:var(--card);border:4px solid var(--ink);padding:14px 16px;box-shadow:6px 6px 0 rgba(0,0,0,.35)}
.card h2{margin:0 0 10px;font-size:18px}.bar{display:grid;grid-template-columns:150px 1fr 46px;gap:8px;align-items:center;margin:6px 0;font-size:13px}
.track{background:#e2ddd0;height:20px}.fill{height:20px;background:var(--yel);border-right:3px solid var(--ink)}
.muted{color:var(--soft);font-size:12px;margin-top:8px}.err{color:#ffb4a6;font-weight:700}
</style></head><body><header></header><main>
<h1>BARCODE BLITZ FEEDBACK</h1><p class="sub">Anonymous answers from the in-game Feedback Terminal. Private page: needs the admin key.</p>
<div class="row"><input id="key" type="password" placeholder="Admin key" autocomplete="current-password" size="30">
<select id="build"><option value="">All builds</option></select><button id="load">SHOW RESULTS</button><span id="msg" class="err"></span></div>
<div class="stats" id="stats"></div><div class="grid" id="grid"></div>
<script>
const $ = (id) => document.getElementById(id);
try { $("key").value = sessionStorage.getItem("bbfb") || ""; } catch (e) {}
function esc(s){return String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function load(){
  $("msg").textContent = "";
  const key = $("key").value.trim();
  try { sessionStorage.setItem("bbfb", key); } catch (e) {}
  const build = $("build").value;
  const res = await fetch("/api/v1/feedback/summary" + (build ? "?build=" + encodeURIComponent(build) : ""), { headers: { "x-admin-key": key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $("msg").textContent = data.error || ("Error " + res.status); return; }
  const sel = $("build"), keep = sel.value;
  sel.innerHTML = '<option value="">All builds</option>' + Object.keys(data.builds).sort().reverse().map((b) => '<option value="' + esc(b) + '">v' + esc(b) + " (" + data.builds[b] + ")</option>").join("");
  sel.value = keep;
  const areas = data.bug_areas;
  $("stats").innerHTML = [["Answers", data.total], ["Last 7 days", data.last_7_days], ["Storage", data.storage], ["Bug areas", "C " + areas.campaign + " · W " + areas.wave + " · R " + areas.rival + " · M " + areas.menus]]
    .map((s) => '<div class="stat"><b>' + esc(s[1]) + "</b><span>" + esc(s[0]) + "</span></div>").join("");
  $("grid").innerHTML = Object.values(data.topics).map((t) => {
    const answered = t.counts.reduce((a, b) => a + b, 0), max = Math.max(1, ...t.counts);
    return '<div class="card"><h2>' + esc(t.title) + "</h2>" + t.labels.map((label, i) =>
      '<div class="bar"><span>' + esc(label) + '</span><div class="track"><div class="fill" style="width:' + (t.counts[i] / max * 100).toFixed(1) + '%"></div></div><b>' + t.counts[i] + "</b></div>").join("") +
      '<div class="muted">' + answered + " answered · " + t.skipped + " skipped</div></div>";
  }).join("");
}
$("load").addEventListener("click", load);
$("build").addEventListener("change", load);
$("key").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
if ($("key").value) load();
</script></main></body></html>`;

module.exports = { handle, validate, summarize };
