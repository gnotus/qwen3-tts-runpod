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

- [x] G2: the live endpoint is load-balanced and restricted to one worker and one GPU
  CHECK: node scripts/verify-results.mjs endpoint
  EXPECT: live endpoint limits verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=68a64f186feddb84920ef4d6b8b8ec26c2e5105f04ee2048ead80dbbb5a6b6be; output-bytes=30

- [x] G3: a scale-from-zero cold start reaches a healthy serving state and records its elapsed time
  CHECK: node scripts/verify-results.mjs cold
  EXPECT: cold start evidence verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=3abf23c29370c99517f8baad8993b31b8ef8514b5c87767d3850d08b1801f1d3; output-bytes=29

- [x] G4: the Aura streaming request returns playable 24 kHz audio and records time to first audio byte
  CHECK: node scripts/verify-results.mjs streaming
  EXPECT: streaming evidence verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=412ccf547c650b44c816a1ed66b95245e9b5ad69bcd2c23a6e57b71976d0b7f5; output-bytes=28

- [x] G5: the audiobook request returns playable audio and records duration, runtime, real-time factor, and cost
  CHECK: node scripts/verify-results.mjs audiobook
  EXPECT: audiobook evidence verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=39f8cdcf31ee9732f1eed98db1742e3e0119a4baecdada71aab1fc36cf2436c6; output-bytes=28

- [x] G6: ten simultaneous requests complete while the endpoint remains capped at one active worker
  CHECK: node scripts/verify-results.mjs concurrency
  EXPECT: single-worker concurrency evidence verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/gnotus/Documents/gnotus.ai/runpod/qwen3-tts-vllm; path=09f74b907d5b/36 entries; EXPECT=matched; output-sha256=d8fb4459d06f62b6552ff24c3a152bcc5a0b580a8f6c5ad22b5fcc5a49691af7; output-bytes=44
