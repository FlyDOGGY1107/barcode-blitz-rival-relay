"use strict";

// Starts the relay with no database (in-memory feedback) and checks the
// feedback routes. Run with: npm test
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

const port = 19600 + Math.floor(Math.random() * 300);
const adminKey = "test-admin-key-0123456789";
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(port), FEEDBACK_ADMIN_KEY: adminKey, SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not start")), 5000);
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening")) { clearTimeout(timer); resolve(); }
    });
    server.once("exit", (code) => reject(new Error(`relay exited early: ${code}`)));
  });
}

const base = `http://127.0.0.1:${port}`;
const good = { v: 1, build: "1.6.0", answers: { scanner: 0, pacing: 2, clarity: -1, bugs: 2 }, bug_area: "wave" };
const post = (body, ip) => fetch(`${base}/api/v1/feedback`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": ip || "203.0.113.5" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

(async () => {
  try {
    await waitForServer();
    assert.strictEqual((await fetch(`${base}/health`)).status, 200);

    let res = await post(good);
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await res.json()).stored, "memory");

    // Invalid shapes are refused.
    for (const bad of [
      { ...good, v: 2 },
      { ...good, build: "1.6.0; drop" },
      { ...good, answers: { scanner: 9, pacing: 0, clarity: 0, bugs: 0 } },
      { ...good, answers: { scanner: -1, pacing: -1, clarity: -1, bugs: -1 } },
      { ...good, bug_area: "my house" },
    ]) {
      assert.strictEqual((await post(bad, "198.51.100.1")).status, 400, JSON.stringify(bad));
    }
    assert.strictEqual((await post("{not json", "198.51.100.1")).status, 400);
    assert.strictEqual((await post({ ...good, pad: "x".repeat(4000) }, "198.51.100.1")).status, 413);

    // Extra fields are dropped, not stored; per-IP limit is 3 an hour.
    assert.strictEqual((await post({ ...good, name: "Someone", steam_id: "123" })).status, 201);
    assert.strictEqual((await post(good)).status, 201);
    assert.strictEqual((await post(good)).status, 429);
    assert.strictEqual((await post(good, "203.0.113.77")).status, 201);

    // Results need the admin key.
    assert.strictEqual((await fetch(`${base}/api/v1/feedback/summary`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/v1/feedback/summary`, { headers: { "x-admin-key": "wrong-key-wrong-key-xx" } })).status, 401);
    res = await fetch(`${base}/api/v1/feedback/summary`, { headers: { "x-admin-key": adminKey } });
    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.total, 4);
    assert.deepStrictEqual(summary.topics.scanner.counts, [4, 0, 0, 0, 0]);
    assert.strictEqual(summary.topics.clarity.skipped, 4);
    assert.strictEqual(summary.bug_areas.wave, 4);
    assert.strictEqual(summary.builds["1.6.0"], 4);
    assert.ok(!JSON.stringify(summary).includes("Someone"));

    res = await fetch(`${base}/feedback`);
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes("BARCODE BLITZ FEEDBACK"));

    console.log("feedback tests passed");
    server.kill();
    process.exit(0);
  } catch (error) {
    console.error(error);
    server.kill();
    process.exit(1);
  }
})();
