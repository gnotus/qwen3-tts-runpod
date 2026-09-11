# Qwen3-TTS 1.7B Base on RunPod Serverless

This deployment runs the official `vllm/vllm-omni:v0.28.0` image and the official
single-GPU `qwen3_tts.yaml` recipe. A small gateway supplies RunPod's required
`GET /ping` liveness route and transparently proxies HTTP streaming and
WebSockets to vLLM-Omni. The liveness route stays HTTP 200 while the model is
loading so RunPod does not create replacement workers; `GET /ready` reports
when inference is actually ready.

The intended RunPod configuration is:

- endpoint type: load balancer
- GPU count: 1
- workers: minimum 0, maximum 1
- model: `Qwen/Qwen3-TTS-12Hz-1.7B-Base`
- public port and health port: 8000
- internal vLLM port: 8091

vLLM-Omni performs batching inside the one model server. Raising RunPod's worker
count is deliberately not part of this design.

## Startup

The RunPod start command downloads `start.sh` and `gateway.py` from this repository
at a pinned Git commit, then executes `start.sh`. Model weights are attached through
RunPod's Hugging Face model cache when the endpoint is created.

## API

The endpoint exposes vLLM-Omni's native API at:

```text
POST /v1/audio/speech
WS   /v1/audio/speech/stream
GET  /health
GET  /ready
GET  /v1/models
```

Base voice-clone requests use `task_type: "Base"`, `ref_audio`, and `ref_text`.
HTTP streaming additionally uses `stream: true`, `stream_format: "audio"`, and
`response_format: "pcm"`.
