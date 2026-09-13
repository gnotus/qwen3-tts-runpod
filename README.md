# Qwen3-TTS 1.7B Base on RunPod Serverless

This deployment runs the official `vllm/vllm-omni:v0.28.0` image and the official
single-GPU `qwen3_tts.yaml` recipe. A small gateway supplies RunPod's required
`GET /ping` readiness route and transparently proxies HTTP streaming and
WebSockets to vLLM-Omni. The optimized gateway returns HTTP 204 while the model
loads and HTTP 200 only when inference is actually ready; `GET /ready` exposes
the same state with startup timing details for benchmarks.

The original audiobook endpoint configuration is:

- endpoint type: load balancer
- GPU count: 1
- workers: minimum 0, maximum 1
- model: `Qwen/Qwen3-TTS-12Hz-1.7B-Base`
- public port and health port: 8000
- internal vLLM port: 8091

The Aura voice-agent endpoint should be a separate clone with minimum 1 and
maximum 1 worker initially. This keeps the model ready without allowing long
audiobook requests to delay live conversations. Raise the Aura maximum only
after measuring single-worker streaming capacity.

## Startup

For the older endpoint, the RunPod start command downloads `start.sh` and
`gateway.py` from this repository at a pinned Git commit. The optimized deployment
uses the included `Dockerfile`, which bakes both files into the image and removes
that network dependency from every boot. Model weights should remain attached
through RunPod's Hugging Face model cache.

The gateway returns HTTP 204 from `/ping` until the vLLM backend is genuinely
ready, then HTTP 200. `/ready` also reports the container-to-model startup time,
allowing the benchmark to separate provisioning delay from model initialization.

Recommended Aura settings:

- endpoint type: load balancer
- GPU count: 1
- workers: minimum 1, maximum 1 for the first capacity test
- FlashBoot: enabled
- request-count scaler: 1 when maximum workers is later raised
- public port and health port: 8000

## Aura four-stream benchmark

`scripts/benchmark-aura-4-streams.mjs` launches four streaming requests together:
two English, one Spanish, and one Brazilian-Portuguese request. It writes a new
timestamped evidence file and four WAV files on every run; previous evidence is
never overwritten.

```bash
RUNPOD_GPU_HOURLY_USD=0.69 \
node scripts/benchmark-aura-4-streams.mjs all
```

Modes are `all`, `boot`, and `streams`. A boot measurement is only classified as
cold when the client observes a non-ready state or waits at least ten seconds. If
the Aura endpoint has a minimum worker of one and is already ready, the evidence
correctly records `already_warm` rather than inventing a cold-start number.

Set `QWEN_TTS_REFERENCE` to the authorized Aura voice reference. Cost assumptions
can be changed with `RUNPOD_GPU_HOURLY_USD`, `RUNPOD_WORKERS_USED`, and
`AURA_TTS_SPEAKING_DUTY_CYCLE`. The report includes time to first audio for every
stream, p50/p95 TTFA, aggregate audio throughput, test cost, cost per generated
audio hour, and cost per conversation hour at the selected speaking duty cycle.

## API

The endpoint exposes vLLM-Omni's native API at:

```text
POST /v1/audio/speech
WS   /v1/audio/speech/stream
GET  /health
GET  /ready
GET  /v1/models
```

Base voice-clone requests use `task_type: "Base"` and `ref_audio`. Antonio's
audiobook reference uses `x_vector_only_mode: true` without `ref_text`, matching
the project's speaker-embedding workflow. ICL cloning can instead supply the
exact reference transcript through `ref_text`.
HTTP streaming additionally uses `stream: true`, `stream_format: "audio"`, and
`response_format: "pcm"`.
