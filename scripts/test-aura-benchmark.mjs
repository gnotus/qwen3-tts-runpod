import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-benchmark-test-"));
const referencePath = path.join(temporaryDir, "reference.wav");
fs.writeFileSync(referencePath, Buffer.alloc(48_000));

let active = 0;
let maximumActive = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/ready") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ready: true, model_ready_after_seconds: 12.5 }));
    return;
  }
  if (request.url !== "/v1/audio/speech" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }

  active += 1;
  maximumActive = Math.max(maximumActive, active);
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    setTimeout(() => response.write(Buffer.alloc(12_000, 1)), 25);
    setTimeout(() => {
      response.end(Buffer.alloc(12_000, 2));
      active -= 1;
    }, 75);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");

const child = spawn(process.execPath, [path.join(root, "scripts", "benchmark-aura-4-streams.mjs"), "streams"], {
  cwd: root,
  env: {
    ...process.env,
    RUNPOD_QWEN_TTS_KEY: "rpa_test_only",
    RUNPOD_TTS_ENDPOINT_ID: "mock-aura",
    RUNPOD_TTS_BASE_URL: `http://127.0.0.1:${address.port}`,
    RUNPOD_SKIP_CONTROL_HEALTH: "1",
    QWEN_TTS_REFERENCE: referencePath,
    RUNPOD_GPU_HOURLY_USD: "0.69",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const exitCode = await new Promise((resolve) => child.on("close", resolve));
server.close();

assert.equal(exitCode, 0, stderr);
assert.equal(maximumActive, 4, "the benchmark did not overlap all four requests");
const evidenceLine = stdout.split(/\r?\n/).find((line) => line.startsWith("EVIDENCE "));
assert(evidenceLine, "benchmark did not print its evidence path");
const evidencePath = evidenceLine.slice("EVIDENCE ".length);
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
assert.equal(evidence.four_streams.concurrency_requested, 4);
assert.equal(evidence.four_streams.completed, 4);
assert.equal(evidence.four_streams.failed, 0);
assert.equal(evidence.four_streams.streams.length, 4);
assert(evidence.four_streams.estimated_cost_per_generated_audio_hour_usd > 0);
for (const stream of evidence.four_streams.streams) {
  assert.equal(stream.http_status, 200);
  assert(stream.ttfa_seconds > 0);
  assert(fs.existsSync(path.join(root, stream.audio_path)));
}

const outputDirectory = path.dirname(path.join(root, evidence.four_streams.streams[0].audio_path));
fs.rmSync(outputDirectory, { recursive: true });
fs.rmSync(evidencePath);
fs.rmSync(temporaryDir, { recursive: true });
console.log("Aura four-stream benchmark verified with four overlapping streams");
