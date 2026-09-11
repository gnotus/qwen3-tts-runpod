import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const root = path.resolve(import.meta.dirname, "..");
const evidencePath = path.join(root, "evidence", "antonio-session.json");

if (!fs.existsSync(evidencePath)) throw new Error(`missing ${evidencePath}`);
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

function assert(value, message) {
  if (!value) throw new Error(message);
}

function playable(relativePath, expectedSampleRate = 24000) {
  const absolutePath = path.join(root, relativePath);
  assert(fs.existsSync(absolutePath), `missing audio ${relativePath}`);
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=sample_rate,channels", "-of", "json", absolutePath],
    { encoding: "utf8" },
  );
  assert(probe.status === 0, `ffprobe failed for ${relativePath}`);
  const parsed = JSON.parse(probe.stdout);
  assert(Number(parsed.format?.duration) > 0, `audio has no duration: ${relativePath}`);
  assert(Number(parsed.streams?.[0]?.sample_rate) === expectedSampleRate, `unexpected sample rate: ${relativePath}`);
  assert(Number(parsed.streams?.[0]?.channels) === 1, `unexpected channel count: ${relativePath}`);
}

switch (mode) {
  case "endpoint":
    assert(evidence.endpoint?.type === "LOAD_BALANCER", "endpoint is not load balanced");
    assert(evidence.endpoint?.workers_min === 0, "minimum workers must be zero after tests");
    assert(evidence.endpoint?.workers_max === 1, "maximum workers must be one");
    assert(evidence.endpoint?.gpu_count === 1, "GPU count must be one");
    console.log("live endpoint limits verified");
    break;
  case "cold":
    assert(Number(evidence.cold_start?.seconds_to_ready) > 0, "cold-start duration missing");
    assert(evidence.cold_start?.ready === true, "endpoint never became ready");
    console.log("cold start evidence verified");
    break;
  case "streaming":
    assert(Number(evidence.streaming?.ttfa_seconds) > 0, "TTFA missing");
    assert(Number(evidence.streaming?.http_status) === 200, "streaming request failed");
    playable(evidence.streaming.audio_path);
    console.log("streaming evidence verified");
    break;
  case "audiobook":
    assert(Number(evidence.audiobook?.request_seconds) > 0, "audiobook runtime missing");
    assert(Number(evidence.audiobook?.audio_seconds) > 0, "audiobook duration missing");
    assert(Number(evidence.audiobook?.rtf) > 0, "audiobook RTF missing");
    assert(Number(evidence.audiobook?.estimated_gpu_cost_usd) > 0, "audiobook cost missing");
    playable(evidence.audiobook.audio_path);
    console.log("audiobook evidence verified");
    break;
  case "concurrency":
    assert(evidence.concurrency?.request_count >= 4, "expected at least four concurrent requests");
    assert(
      evidence.concurrency?.completed === evidence.concurrency?.request_count,
      "not all concurrent requests completed",
    );
    assert(evidence.concurrency?.maximum_live_workers === 1, "more than one worker was observed");
    assert(evidence.endpoint?.workers_max === 1, "endpoint worker cap changed");
    for (const item of evidence.concurrency.outputs ?? []) playable(item.audio_path);
    console.log("single-worker concurrency evidence verified");
    break;
  default:
    throw new Error("usage: node scripts/verify-results.mjs endpoint|cold|streaming|audiobook|concurrency");
}
