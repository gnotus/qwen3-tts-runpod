# Gates: Qwen3-TTS vLLM-Omni RunPod Serverless

OWNS: runpod/qwen3-tts-vllm/**

Scope: deploy and verify one-GPU, one-worker Qwen3-TTS Base serving for low-latency streaming, audiobook throughput, and in-process request batching

- [x] G0: the completion ledger is structurally sound
  CHECK: node /Users/gnotus/.codex/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] G1: the deployment contract pins the official vLLM-Omni release and exposes a RunPod-compatible health gateway
  CHECK: node scripts/verify-static.mjs
  EXPECT: static deployment contract verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=35d2d2faa166f2e101e62b781a9c6e75a772e0bdd3e7807c189714018cab18c1; output-bytes=36

- [ ] G2: the live endpoint is load-balanced and restricted to one worker and one GPU
  CHECK: node scripts/verify-results.mjs endpoint
  EXPECT: live endpoint limits verified
  EVIDENCE: pending

- [ ] G3: a scale-from-zero cold start reaches a healthy serving state and records its elapsed time
  CHECK: node scripts/verify-results.mjs cold
  EXPECT: cold start evidence verified
  EVIDENCE: pending

- [ ] G4: the Aura streaming request returns playable 24 kHz audio and records time to first audio byte
  CHECK: node scripts/verify-results.mjs streaming
  EXPECT: streaming evidence verified
  EVIDENCE: pending

- [ ] G5: the audiobook request returns playable audio and records duration, runtime, real-time factor, and cost
  CHECK: node scripts/verify-results.mjs audiobook
  EXPECT: audiobook evidence verified
  EVIDENCE: pending

- [ ] G6: four simultaneous requests complete while the endpoint remains capped at one worker
  CHECK: node scripts/verify-results.mjs concurrency
  EXPECT: single-worker concurrency evidence verified
  EVIDENCE: pending
