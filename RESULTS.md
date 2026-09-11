# RunPod Qwen3-TTS Antonio benchmark results

Measured on 2026-09-11 with `Qwen/Qwen3-TTS-12Hz-1.7B-Base`, vLLM-Omni
`v0.28.0`, and one NVIDIA GeForce RTX 4090 (24 GB) at $1.10/GPU-hour.

The earlier Aura/Portuguese-reference run was invalid for this audiobook test
and is excluded from every result below.

## Endpoint

- endpoint: `vllm-7lg4mza88egpuc`
- type: load balancer
- GPU count per worker: 1
- worker limits during test: minimum 1, maximum 1
- final worker limits: minimum 0, maximum 0 (paused to prevent more spend)
- final running workers: 0
- FlashBoot: off
- scale-out threshold: 100 requests

RunPod displayed up to two additional provider-side capacity candidates in
`INITIALIZING`, even though the endpoint cap was one. They never reached
`RUNNING` during the measured burst. Exactly one GPU worker was active while
all ten requests completed.

## Correct inputs

- reference voice: `tts/es/reference_voice/reference_spanish_9s.wav`
- reference mode: speaker embedding only (`x_vector_only_mode: true`)
- reference duration: 9.45 seconds, 24 kHz mono
- target language: Spanish for streaming, audiobook, and all concurrent jobs
- audiobook source: `tts/es/02_introduccion/q_01_introduccion.txt`

## Results

- scale-from-zero readiness: 288.040 seconds
- warm HTTP audio streaming: 14.178 seconds to first audio byte, 15.008 seconds
  total for 4.80 seconds of Antonio-voice Spanish audio
- Spanish audiobook: 68.56 seconds of audio in 24.305 seconds, RTF 0.355
- estimated audiobook compute: $0.00743 for the request, or $0.390 per
  generated audio hour
- ten simultaneous Spanish requests: all 10 complete in 17.342 seconds
- concurrent batch output: 62.96 seconds of audio, 3.631x aggregate real time
- estimated concurrent batch compute: $0.00530 total, $0.000530 per request,
  or $0.303 per aggregate generated audio hour

The RunPod billing API had not yet posted endpoint-level records when checked.
The console balance moved from $10.34 to $9.44 during the full deployment and
debugging session, a $0.90 account-balance change. That figure includes cold
starts and failed/replaced startup attempts; it is not the steady-state cost of
the successful requests.
