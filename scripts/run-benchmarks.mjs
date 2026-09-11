import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "..");
const endpointId = "vllm-7lg4mza88egpuc";
const apiBase = `https://${endpointId}.api.runpod.ai`;
const model = "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
const gpuHourlyUsd = 1.58;
// Version 1 spent 40 minutes in RunPod's free image-provisioning state and
// never started the container. Version 2 pins the same amd64 image explicitly.
const createdAt = process.env.RUNPOD_RELEASE_CREATED_AT || "2026-09-11T10:04:57.334Z";
const referencePath =
  process.env.QWEN_TTS_REFERENCE ||
  "/Users/gnotus/Documents/speech-to-speech/demo/pocket-tts-eval-2026-09-10/pocket-portuguese-aura-alba-matched.wav";
const referenceText =
  "Bom dia! Eu sou a Aura e estou aqui para ajudar você a começar o dia com clareza, calma e confiança.";
const audiobookSource =
  process.env.QWEN_TTS_AUDIOBOOK_TEXT ||
  "/Users/gnotus/Documents/FADITECH/antoniocordeiroapp/tts/es/02_introduccion/01_introduccion.txt";

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

const localEnv = loadEnv(path.resolve(root, "..", "..", ".env"));
const apiKey = process.env.RUNPOD_QWEN_TTS_KEY || localEnv.RUNPOD_QWEN_TTS_KEY;
if (!apiKey?.startsWith("rpa_")) {
  throw new Error("RUNPOD_QWEN_TTS_KEY is missing from /Users/gnotus/Documents/gnotus.ai/.env");
}

const outputDir = path.join(root, "outputs");
const evidenceDir = path.join(root, "evidence");
const evidencePath = path.join(evidenceDir, "session.json");
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

function basePayload(input, responseFormat = "wav") {
  const audio = fs.readFileSync(referencePath).toString("base64");
  return {
    model,
    input,
    voice: "aura-reference",
    response_format: responseFormat,
    task_type: "Base",
    language: "Auto",
    ref_audio: `data:audio/wav;base64,${audio}`,
    ref_text: referenceText,
  };
}

function readEvidence() {
  if (!fs.existsSync(evidencePath)) return {};
  return JSON.parse(fs.readFileSync(evidencePath, "utf8"));
}

function writeEvidence(patch) {
  const next = { ...readEvidence(), ...patch };
  fs.writeFileSync(evidencePath, `${JSON.stringify(next, null, 2)}\n`);
}

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function wavSeconds(buffer) {
  if (buffer.subarray(0, 4).toString() !== "RIFF") throw new Error("response is not a WAV file");
  const byteRate = buffer.readUInt32LE(28);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const name = buffer.subarray(offset, offset + 4).toString();
    const size = buffer.readUInt32LE(offset + 4);
    if (name === "data") return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
}

async function checkedSpeech(payload, timeoutMs = 1_200_000) {
  const response = await fetch(`${apiBase}/v1/audio/speech`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`speech HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function waitForColdStart() {
  const deadline = Date.now() + 30 * 60_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/ready`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      lastStatus = response.status;
      if (response.status === 200) {
        const readyAt = new Date().toISOString();
        const seconds = (Date.parse(readyAt) - Date.parse(createdAt)) / 1000;
        writeEvidence({ cold_start: { created_at: createdAt, ready_at: readyAt, seconds_to_ready: seconds, ready: true } });
        console.log(`READY cold_start=${seconds.toFixed(1)}s`);
        return;
      }
    } catch (error) {
      lastStatus = error.name === "TimeoutError" ? 408 : 0;
    }
    console.log(`WAIT ready_status=${lastStatus}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`endpoint did not become ready; last readiness status ${lastStatus}`);
}

async function runStreaming() {
  const started = performance.now();
  const payload = {
    ...basePayload("Olá! Eu sou a Aura. Como posso ajudar você hoje?", "pcm"),
    stream: true,
    stream_format: "audio",
    initial_codec_chunk_frames: 2,
  };
  const response = await checkedSpeech(payload);
  const reader = response.body.getReader();
  const chunks = [];
  let ttfaMs;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      if (ttfaMs === undefined) ttfaMs = performance.now() - started;
      chunks.push(Buffer.from(value));
    }
  }
  if (ttfaMs === undefined) throw new Error("stream returned no audio bytes");
  const pcm = Buffer.concat(chunks);
  const wav = pcmToWav(pcm);
  const relative = "outputs/aura-stream.wav";
  fs.writeFileSync(path.join(root, relative), wav);
  const totalSeconds = (performance.now() - started) / 1000;
  writeEvidence({
    streaming: {
      http_status: response.status,
      ttfa_seconds: ttfaMs / 1000,
      total_seconds: totalSeconds,
      audio_seconds: pcm.length / 48000,
      audio_path: relative,
      initial_codec_chunk_frames: 2,
    },
  });
  console.log(`STREAM ttfa=${(ttfaMs / 1000).toFixed(3)}s total=${totalSeconds.toFixed(3)}s`);
}

function audiobookExcerpt() {
  return fs
    .readFileSync(audiobookSource, "utf8")
    .replace(/^--- CHUNK \d+ ---$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

async function runAudiobook() {
  const started = performance.now();
  const response = await checkedSpeech(basePayload(audiobookExcerpt(), "wav"));
  const wav = Buffer.from(await response.arrayBuffer());
  const requestSeconds = (performance.now() - started) / 1000;
  const audioSeconds = wavSeconds(wav);
  const rtf = requestSeconds / audioSeconds;
  const relative = "outputs/audiobook-spanish.wav";
  fs.writeFileSync(path.join(root, relative), wav);
  writeEvidence({
    audiobook: {
      http_status: response.status,
      characters: audiobookExcerpt().length,
      request_seconds: requestSeconds,
      audio_seconds: audioSeconds,
      rtf,
      estimated_gpu_cost_usd: (requestSeconds / 3600) * gpuHourlyUsd,
      estimated_cost_per_audio_hour_usd: rtf * gpuHourlyUsd,
      audio_path: relative,
    },
  });
  console.log(
    `AUDIOBOOK runtime=${requestSeconds.toFixed(3)}s audio=${audioSeconds.toFixed(3)}s rtf=${rtf.toFixed(3)} cost_per_audio_hour=$${(rtf * gpuHourlyUsd).toFixed(3)}`,
  );
}

async function oneConcurrent(index) {
  const texts = [
    "Sua consulta está confirmada para amanhã às dez horas.",
    "Encontrei três horários disponíveis para esta semana.",
    "Posso enviar um resumo desta conversa por mensagem.",
    "Um momento, por favor. Estou verificando essa informação.",
    "A sua solicitação foi recebida e já está sendo processada.",
    "Vou consultar os dados e retorno com uma resposta em instantes.",
    "Seu pagamento foi confirmado com sucesso. Obrigada pela preferência.",
    "Posso ajudar com mais alguma informação antes de encerrarmos?",
    "O atendimento está quase concluído. Só preciso confirmar um detalhe.",
    "Tudo certo. O comprovante será enviado para o seu endereço de e-mail.",
  ];
  const started = performance.now();
  const response = await checkedSpeech(basePayload(texts[index], "wav"));
  const wav = Buffer.from(await response.arrayBuffer());
  const relative = `outputs/concurrent-${index + 1}.wav`;
  fs.writeFileSync(path.join(root, relative), wav);
  return {
    http_status: response.status,
    request_seconds: (performance.now() - started) / 1000,
    audio_seconds: wavSeconds(wav),
    audio_path: relative,
  };
}

async function runConcurrency() {
  const requestCount = Number.parseInt(process.env.QWEN_TTS_CONCURRENCY || "10", 10);
  if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 10) {
    throw new Error("QWEN_TTS_CONCURRENCY must be an integer from 1 to 10");
  }
  const started = performance.now();
  const outputs = await Promise.all(Array.from({ length: requestCount }, (_, index) => oneConcurrent(index)));
  const wallSeconds = (performance.now() - started) / 1000;
  writeEvidence({
    concurrency: {
      request_count: requestCount,
      completed: outputs.length,
      maximum_live_workers: null,
      wall_seconds: wallSeconds,
      estimated_batch_cost_usd: (wallSeconds / 3600) * gpuHourlyUsd,
      estimated_cost_per_request_usd: ((wallSeconds / 3600) * gpuHourlyUsd) / outputs.length,
      outputs,
    },
  });
  console.log(`CONCURRENCY completed=${outputs.length} wall=${wallSeconds.toFixed(3)}s`);
}

function recordObservedWorkers() {
  const observed = Number.parseInt(process.env.RUNPOD_MAX_LIVE_WORKERS_OBSERVED || "", 10);
  if (!Number.isInteger(observed) || observed < 0) {
    throw new Error("RUNPOD_MAX_LIVE_WORKERS_OBSERVED is required for record-workers mode");
  }
  const evidence = readEvidence();
  if (!evidence.concurrency) throw new Error("run concurrency before recording worker evidence");
  writeEvidence({ concurrency: { ...evidence.concurrency, maximum_live_workers: observed } });
  console.log(`WORKERS maximum_live_workers=${observed}`);
}

async function main() {
  const mode = process.argv[2] || "all";
  if (["wait", "all"].includes(mode)) await waitForColdStart();
  if (["streaming", "all"].includes(mode)) await runStreaming();
  if (["audiobook", "all"].includes(mode)) await runAudiobook();
  if (["concurrency", "all"].includes(mode)) await runConcurrency();
  if (mode === "record-workers") recordObservedWorkers();
}

await main();
