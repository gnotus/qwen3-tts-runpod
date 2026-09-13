import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(root, "..", "..");

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.trimStart().startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
      }),
  );
}

const localEnv = loadEnv(path.join(workspaceRoot, ".env"));
const endpointId = process.env.RUNPOD_TTS_ENDPOINT_ID || "vllm-7lg4mza88egpuc";
const apiBase = process.env.RUNPOD_TTS_BASE_URL || `https://${endpointId}.api.runpod.ai`;
const apiKey =
  process.env.RUNPOD_QWEN_TTS_KEY ||
  process.env.RUNPOD_API_KEY ||
  localEnv.RUNPOD_API_KEY ||
  localEnv.RUNPOD_QWEN_TTS_KEY;
const model = process.env.QWEN_TTS_MODEL || "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
const referencePath =
  process.env.QWEN_TTS_REFERENCE ||
  "/Users/gnotus/Documents/FADITECH/antoniocordeiroapp/tts/es/reference_voice/reference_spanish_9s.wav";
const gpuHourlyUsd = numberEnv("RUNPOD_GPU_HOURLY_USD", 0.69, { min: 0 });
const workersUsed = numberEnv("RUNPOD_WORKERS_USED", 1, { min: 1, integer: true });
const speakingDutyCycle = numberEnv("AURA_TTS_SPEAKING_DUTY_CYCLE", 0.4, { min: 0, max: 1 });
const requestTimeoutMs = numberEnv("AURA_TTS_REQUEST_TIMEOUT_MS", 120_000, { min: 1_000, integer: true });
const mode = process.argv[2] || "all";

if (!apiKey?.startsWith("rpa_")) {
  throw new Error("Set RUNPOD_QWEN_TTS_KEY or RUNPOD_API_KEY; credentials are never written to evidence.");
}
if (!fs.existsSync(referencePath)) throw new Error(`Missing Qwen voice reference: ${referencePath}`);
if (!new Set(["all", "boot", "streams"]).has(mode)) {
  throw new Error("Usage: node scripts/benchmark-aura-4-streams.mjs [all|boot|streams]");
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(root, "outputs", `aura-4-streams-${runId}`);
const evidenceDir = path.join(root, "evidence");
const evidencePath = path.join(evidenceDir, `aura-4-streams-${runId}.json`);
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};
const referenceAudio = fs.readFileSync(referencePath).toString("base64");
const prompts = [
  { language: "English", text: "Hello, I am Aura. How can I help you today?" },
  { language: "Spanish", text: "Hola, soy Aura. ¿Cómo puedo ayudarte hoy?" },
  { language: "Portuguese", text: "Olá, eu sou a Aura. Como posso ajudar você hoje?" },
  { language: "English", text: "I found the information. Let me explain it clearly and briefly." },
];

function numberEnv(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return value;
}

function pcmToWav(pcm, sampleRate = 24_000) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

async function jsonOrNull(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function endpointHealth() {
  if (process.env.RUNPOD_SKIP_CONTROL_HEALTH === "1") return { skipped: true };
  try {
    const response = await fetch(`https://api.runpod.ai/v2/${endpointId}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? await jsonOrNull(response) : { http_status: response.status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function measureBoot() {
  const started = performance.now();
  const statuses = [];
  let sawColdSignal = false;
  const deadline = Date.now() + 20 * 60_000;

  while (Date.now() < deadline) {
    const attemptStarted = performance.now();
    try {
      const response = await fetch(`${apiBase}/ready`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      const attemptSeconds = (performance.now() - attemptStarted) / 1000;
      const body = await jsonOrNull(response);
      statuses.push({ http_status: response.status, attempt_seconds: attemptSeconds });
      if (response.status === 200) {
        const clientSeconds = (performance.now() - started) / 1000;
        const serverSeconds = Number(body?.model_ready_after_seconds);
        const observedCold = sawColdSignal || clientSeconds >= 10;
        return {
          observed_cold_start: observedCold,
          already_warm: !observedCold,
          client_seconds_to_ready: clientSeconds,
          server_model_ready_after_seconds: Number.isFinite(serverSeconds) ? serverSeconds : null,
          provisioning_and_routing_seconds:
            observedCold && Number.isFinite(serverSeconds) ? Math.max(0, clientSeconds - serverSeconds) : null,
          statuses,
        };
      }
      sawColdSignal = true;
    } catch (error) {
      sawColdSignal = true;
      statuses.push({ error: error instanceof Error ? error.name : String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Endpoint did not become model-ready within 20 minutes");
}

async function requireWarmModel() {
  let response;
  try {
    response = await fetch(`${apiBase}/ready`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Warm-stream preflight timed out after 20 seconds; no synthesis requests were launched");
    }
    throw error;
  }
  const body = await jsonOrNull(response);
  if (response.status !== 200 || body?.ready === false) {
    throw new Error(`Warm-stream preflight failed: /ready returned HTTP ${response.status}`);
  }
  return body;
}

function speechPayload(item) {
  return {
    model,
    input: item.text,
    voice: "aura-reference",
    response_format: "pcm",
    task_type: "Base",
    language: item.language,
    ref_audio: `data:audio/wav;base64,${referenceAudio}`,
    x_vector_only_mode: true,
    stream: true,
    stream_format: "audio",
    initial_codec_chunk_frames: 1,
  };
}

async function streamOne(item, index, sharedStart) {
  const started = performance.now();
  const response = await fetch(`${apiBase}/v1/audio/speech`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(speechPayload(item)),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Stream ${index + 1} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const headersSeconds = (performance.now() - started) / 1000;
  const reader = response.body.getReader();
  const chunks = [];
  let firstAudioSeconds = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      firstAudioSeconds ??= (performance.now() - started) / 1000;
      chunks.push(Buffer.from(value));
    }
  }
  if (firstAudioSeconds === null) throw new Error(`Stream ${index + 1} returned no audio`);

  const pcm = Buffer.concat(chunks);
  const audioSeconds = pcm.length / 48_000;
  const totalSeconds = (performance.now() - started) / 1000;
  const relativePath = path.relative(root, path.join(outputDir, `stream-${index + 1}-${item.language.toLowerCase()}.wav`));
  fs.writeFileSync(path.join(root, relativePath), pcmToWav(pcm));
  return {
    stream: index + 1,
    language: item.language,
    characters: item.text.length,
    launch_offset_ms: started - sharedStart,
    http_status: response.status,
    headers_seconds: headersSeconds,
    ttfa_seconds: firstAudioSeconds,
    total_seconds: totalSeconds,
    audio_seconds: audioSeconds,
    realtime_factor: totalSeconds / audioSeconds,
    chunks: chunks.length,
    bytes: pcm.length,
    audio_path: relativePath,
  };
}

async function runFourStreams() {
  const readiness =
    process.env.AURA_TTS_SKIP_READINESS === "1"
      ? { skipped: true }
      : await requireWarmModel();
  const healthBefore = await endpointHealth();
  const sharedStart = performance.now();
  const settled = await Promise.allSettled(prompts.map((item, index) => streamOne(item, index, sharedStart)));
  const wallSeconds = (performance.now() - sharedStart) / 1000;
  const healthAfter = await endpointHealth();
  const streams = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  const failures = settled
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === "rejected")
    .map(({ item, index }) => ({
      stream: index + 1,
      language: prompts[index].language,
      message: item.reason instanceof Error ? item.reason.message : String(item.reason),
    }));
  const audioSeconds = streams.reduce((sum, item) => sum + item.audio_seconds, 0);
  const testCostUsd = (wallSeconds / 3600) * gpuHourlyUsd * workersUsed;
  const costPerGeneratedAudioHourUsd = audioSeconds > 0 ? testCostUsd / (audioSeconds / 3600) : null;
  const ttfas = streams.map((item) => item.ttfa_seconds);
  return {
    concurrency_requested: prompts.length,
    completed: streams.length,
    failed: failures.length,
    wall_seconds: wallSeconds,
    aggregate_audio_seconds: audioSeconds,
    aggregate_audio_realtime_multiple: audioSeconds / wallSeconds,
    ttfa_p50_seconds: ttfas.length ? percentile(ttfas, 0.5) : null,
    ttfa_p95_seconds: ttfas.length ? percentile(ttfas, 0.95) : null,
    ttfa_max_seconds: ttfas.length ? Math.max(...ttfas) : null,
    gpu_hourly_usd: gpuHourlyUsd,
    workers_used_for_cost: workersUsed,
    estimated_test_cost_usd: testCostUsd,
    estimated_cost_per_generated_audio_hour_usd: costPerGeneratedAudioHourUsd,
    speaking_duty_cycle: speakingDutyCycle,
    estimated_cost_per_conversation_hour_usd:
      costPerGeneratedAudioHourUsd === null ? null : costPerGeneratedAudioHourUsd * speakingDutyCycle,
    cost_per_continuously_active_stream_hour_usd: (gpuHourlyUsd * workersUsed) / prompts.length,
    health_before: healthBefore,
    health_after: healthAfter,
    readiness,
    streams,
    failures,
  };
}

const evidence = {
  schema_version: 1,
  run_id: runId,
  measured_at: new Date().toISOString(),
  endpoint_id: endpointId,
  endpoint_base_url: apiBase,
  model,
  reference_file: path.basename(referencePath),
  assumptions: {
    gpu_hourly_usd: gpuHourlyUsd,
    workers_used: workersUsed,
    speaking_duty_cycle: speakingDutyCycle,
    pcm: "24000 Hz, mono, signed 16-bit",
  },
};

try {
  if (mode === "all" || mode === "boot") evidence.boot = await measureBoot();
  if (mode === "all" || mode === "streams") {
    evidence.four_streams = await runFourStreams();
    if (evidence.four_streams.failed > 0) {
      throw new Error(`${evidence.four_streams.failed} of 4 streaming requests failed`);
    }
  }
} catch (error) {
  evidence.error = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
  process.exitCode = 1;
} finally {
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (evidence.boot) {
  const label = evidence.boot.observed_cold_start ? "cold" : "already-warm";
  console.log(`BOOT ${label} client_to_ready=${evidence.boot.client_seconds_to_ready.toFixed(3)}s`);
}
if (evidence.four_streams) {
  const result = evidence.four_streams;
  console.log(`STREAMS completed=${result.completed} failed=${result.failed} wall=${result.wall_seconds.toFixed(3)}s`);
  if (result.completed > 0) {
    console.log(
      `AUDIO audio=${result.aggregate_audio_seconds.toFixed(3)}s ttfa_p50=${result.ttfa_p50_seconds.toFixed(3)}s ` +
        `ttfa_p95=${result.ttfa_p95_seconds.toFixed(3)}s`,
    );
    console.log(
      `COST test=$${result.estimated_test_cost_usd.toFixed(6)} generated_audio_hour=$${result.estimated_cost_per_generated_audio_hour_usd.toFixed(3)} ` +
        `conversation_hour_at_${Math.round(speakingDutyCycle * 100)}pct=$${result.estimated_cost_per_conversation_hour_usd.toFixed(3)}`,
    );
  }
}
if (evidence.error) console.error(`FAILED ${evidence.error.name}: ${evidence.error.message}`);
console.log(`EVIDENCE ${evidencePath}`);
