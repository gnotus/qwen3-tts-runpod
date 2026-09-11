# RunPod Qwen3-TTS benchmark results

> The first benchmark below used the wrong Aura Portuguese reference and is
> retained only as invalid historical evidence. It must not be treated as an
> Antonio audiobook result. Corrected Antonio/Spanish measurements will replace
> these figures after the rerun.

Measured on 2026-09-11 with `Qwen/Qwen3-TTS-12Hz-1.7B-Base`, vLLM-Omni
`v0.28.0`, and one NVIDIA GeForce RTX 5090 (32 GB) at $1.58/GPU-hour.

## Endpoint

- endpoint: `vllm-7lg4mza88egpuc`
- type: load balancer
- GPU count per worker: 1
- final worker limits: minimum 0, maximum 1
- final running workers: 0
- FlashBoot: off
- scale-out threshold: 100 requests

RunPod displayed up to two additional provider-side capacity candidates in
`INITIALIZING`, even though the endpoint cap was one. They never reached
`RUNNING` during the measured burst. Exactly one GPU worker was active while
all ten requests completed.

## Results

- scale-from-zero readiness: 408.268 seconds
- warm HTTP audio streaming: 6.428 seconds to first audio byte, 7.067 seconds
  total for 5.12 seconds of audio
- observed warm streaming TTFA range across repeated calls: 3.710-8.019 seconds
- Spanish audiobook: 65.52 seconds of audio in 15.581 seconds, RTF 0.238
- estimated audiobook compute: $0.00684 for the request, or $0.376 per
  generated audio hour
- ten simultaneous voice-agent requests: all 10 complete in 11.755 seconds
- concurrent batch output: 44.88 seconds of audio, 3.818x aggregate real time
- estimated concurrent batch compute: $0.00516 total, $0.000516 per request,
  or $0.414 per aggregate generated audio hour

The RunPod billing API had not yet posted endpoint-level records when checked.
The console balance moved from $10.34 to $9.44 during the full deployment and
debugging session, a $0.90 account-balance change. That figure includes cold
starts and failed/replaced startup attempts; it is not the steady-state cost of
the successful requests.
