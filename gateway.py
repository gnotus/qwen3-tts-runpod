"""RunPod load-balancer health adapter and streaming reverse proxy for vLLM-Omni."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, StreamingResponse


BACKEND_HTTP = os.getenv("VLLM_BACKEND_URL", "http://127.0.0.1:8091").rstrip("/")
BACKEND_WS = BACKEND_HTTP.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
STARTED_AT = datetime.now(timezone.utc).isoformat()
STARTED_MONOTONIC = time.monotonic()
MODEL_READY_AFTER_SECONDS: float | None = None
SELFTEST_ENABLED = os.getenv("AURA_SELFTEST", "0") == "1"
SELFTEST_REFERENCE = Path(
    os.getenv("AURA_SELFTEST_REFERENCE", "/tmp/qwen3-tts/selftest_reference.wav")
)
SELFTEST_GPU_HOURLY_USD = float(os.getenv("AURA_SELFTEST_GPU_HOURLY_USD", "1.10"))
SELFTEST_COUNTS = [
    int(value)
    for value in os.getenv("AURA_SELFTEST_COUNTS", "4").split(",")
    if value.strip()
]
INITIAL_CODEC_CHUNK_FRAMES = int(os.getenv("AURA_INITIAL_CODEC_CHUNK_FRAMES", "1"))
PRELOAD_VOICE = os.getenv("AURA_PRELOAD_VOICE", "0") == "1"
PRELOAD_VOICE_NAME = os.getenv("AURA_PRELOAD_VOICE_NAME", "aura-reference")
PRELOAD_VOICE_CONSENT = os.getenv(
    "AURA_PRELOAD_VOICE_CONSENT", "aura-project-authorized-reference"
)
PRELOAD_VOICE_REFERENCE = Path(
    os.getenv("AURA_PRELOAD_VOICE_REFERENCE", str(SELFTEST_REFERENCE))
)
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(timeout=None)
    app.state.voice_preload_task = None
    selftest_task = (
        asyncio.create_task(run_selftest_when_ready(app)) if SELFTEST_ENABLED else None
    )
    try:
        yield
    finally:
        if selftest_task is not None:
            selftest_task.cancel()
        await app.state.client.aclose()


app = FastAPI(lifespan=lifespan)


async def preload_voice_and_warm(app: FastAPI) -> dict[str, object]:
    """Register Aura once per worker and populate the speaker-feature cache."""
    started = time.monotonic()
    if not PRELOAD_VOICE_REFERENCE.exists():
        raise FileNotFoundError(f"missing Aura reference: {PRELOAD_VOICE_REFERENCE}")

    voices = await app.state.client.get(f"{BACKEND_HTTP}/v1/audio/voices")
    voices.raise_for_status()
    registered = PRELOAD_VOICE_NAME in voices.json().get("voices", [])
    if not registered:
        response = await app.state.client.post(
            f"{BACKEND_HTTP}/v1/audio/voices",
            data={
                "consent": PRELOAD_VOICE_CONSENT,
                "name": PRELOAD_VOICE_NAME,
                "speaker_description": "Aura multilingual reference voice",
            },
            files={
                "audio_sample": (
                    PRELOAD_VOICE_REFERENCE.name,
                    PRELOAD_VOICE_REFERENCE.read_bytes(),
                    "audio/wav",
                )
            },
        )
        response.raise_for_status()

    warmup_payload = {
        "model": os.getenv("MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"),
        "input": "Aura is ready.",
        "voice": PRELOAD_VOICE_NAME,
        "response_format": "pcm",
        "task_type": "Base",
        "language": "English",
        "stream": True,
        "stream_format": "audio",
        "initial_codec_chunk_frames": INITIAL_CODEC_CHUNK_FRAMES,
    }
    async with app.state.client.stream(
        "POST", f"{BACKEND_HTTP}/v1/audio/speech", json=warmup_payload
    ) as response:
        response.raise_for_status()
        async for _ in response.aiter_raw():
            pass

    result = {
        "voice": PRELOAD_VOICE_NAME,
        "registered": True,
        "warm": True,
        "seconds": round(time.monotonic() - started, 3),
    }
    print(f"AURA_VOICE_READY {json.dumps(result)}", flush=True)
    return result


def selftest_payload(language: str, text: str, reference_audio: str) -> dict[str, object]:
    return {
        "model": os.getenv("MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"),
        "input": text,
        "voice": "aura-selftest",
        "response_format": "pcm",
        "task_type": "Base",
        "language": language,
        "ref_audio": f"data:audio/wav;base64,{reference_audio}",
        "x_vector_only_mode": True,
        "stream": True,
        "stream_format": "audio",
        "initial_codec_chunk_frames": 1,
    }


async def run_selftest_stream(
    client: httpx.AsyncClient,
    item: dict[str, str],
    index: int,
    reference_audio: str,
    shared_start: float,
) -> dict[str, object]:
    started = time.monotonic()
    chunks = 0
    byte_count = 0
    first_audio_seconds: float | None = None
    async with client.stream(
        "POST",
        f"{BACKEND_HTTP}/v1/audio/speech",
        json=selftest_payload(item["language"], item["text"], reference_audio),
        timeout=None,
    ) as response:
        response.raise_for_status()
        headers_seconds = time.monotonic() - started
        async for chunk in response.aiter_raw():
            if not chunk:
                continue
            if first_audio_seconds is None:
                first_audio_seconds = time.monotonic() - started
            chunks += 1
            byte_count += len(chunk)

    if first_audio_seconds is None:
        raise RuntimeError("stream returned no audio")
    total_seconds = time.monotonic() - started
    audio_seconds = byte_count / 48_000
    return {
        "stream": index + 1,
        "language": item["language"],
        "launch_offset_ms": round((started - shared_start) * 1_000, 3),
        "headers_seconds": round(headers_seconds, 3),
        "ttfa_seconds": round(first_audio_seconds, 3),
        "total_seconds": round(total_seconds, 3),
        "audio_seconds": round(audio_seconds, 3),
        "realtime_factor": round(total_seconds / audio_seconds, 3),
        "chunks": chunks,
        "bytes": byte_count,
    }


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(len(ordered) * fraction + 0.999999) - 1))
    return ordered[index]


async def run_selftest_batch(
    client: httpx.AsyncClient,
    concurrency: int,
    reference_audio: str,
) -> dict[str, object]:
    item = {
        "language": "English",
        "text": "Hello, I am Aura. How can I help you today?",
    }
    shared_start = time.monotonic()
    settled = await asyncio.gather(
        *(
            run_selftest_stream(client, item, index, reference_audio, shared_start)
            for index in range(concurrency)
        ),
        return_exceptions=True,
    )
    wall_seconds = time.monotonic() - shared_start
    streams = [result for result in settled if isinstance(result, dict)]
    failures = [
        {"stream": index + 1, "error": str(result)}
        for index, result in enumerate(settled)
        if isinstance(result, BaseException)
    ]
    aggregate_audio_seconds = sum(float(result["audio_seconds"]) for result in streams)
    ttfas = [float(result["ttfa_seconds"]) for result in streams]
    test_cost = wall_seconds / 3_600 * SELFTEST_GPU_HOURLY_USD
    launch_offsets = [float(result["launch_offset_ms"]) for result in streams]
    return {
        "concurrency_requested": concurrency,
        "completed": len(streams),
        "failed": len(failures),
        "launch_span_ms": round(max(launch_offsets) - min(launch_offsets), 3)
        if launch_offsets
        else None,
        "wall_seconds": round(wall_seconds, 3),
        "aggregate_audio_seconds": round(aggregate_audio_seconds, 3),
        "aggregate_audio_realtime_multiple": (
            round(aggregate_audio_seconds / wall_seconds, 3) if wall_seconds else None
        ),
        "ttfa_min_seconds": round(min(ttfas), 3) if ttfas else None,
        "ttfa_p50_seconds": round(percentile(ttfas, 0.50), 3) if ttfas else None,
        "ttfa_p95_seconds": round(percentile(ttfas, 0.95), 3) if ttfas else None,
        "ttfa_max_seconds": round(max(ttfas), 3) if ttfas else None,
        "gpu_hourly_usd": SELFTEST_GPU_HOURLY_USD,
        "estimated_test_cost_usd": round(test_cost, 6),
        "estimated_cost_per_generated_audio_hour_usd": (
            round(test_cost / (aggregate_audio_seconds / 3_600), 3)
            if aggregate_audio_seconds
            else None
        ),
        "streams": streams,
        "failures": failures,
    }


async def run_selftest_when_ready(app: FastAPI) -> None:
    try:
        backend_ready_after_seconds: float | None = None
        while True:
            try:
                response = await app.state.client.get(f"{BACKEND_HTTP}/health", timeout=1.0)
                if response.status_code == 200:
                    backend_ready_after_seconds = time.monotonic() - STARTED_MONOTONIC
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1)

        reference_audio = base64.b64encode(SELFTEST_REFERENCE.read_bytes()).decode("ascii")
        warmup = await run_selftest_batch(app.state.client, 1, reference_audio)
        print(f"AURA_LOADTEST_WARMUP {json.dumps(warmup, ensure_ascii=False)}", flush=True)
        await asyncio.sleep(1)

        profiles = []
        for concurrency in SELFTEST_COUNTS:
            profile = await run_selftest_batch(app.state.client, concurrency, reference_audio)
            profiles.append(profile)
            print(f"AURA_LOADTEST_RESULT {json.dumps(profile, ensure_ascii=False)}", flush=True)
            await asyncio.sleep(1)

        result = {
            "counts": SELFTEST_COUNTS,
            "model_ready_after_seconds": round(backend_ready_after_seconds, 3),
            "loadtest_completed_after_seconds": round(time.monotonic() - STARTED_MONOTONIC, 3),
            "profiles": profiles,
        }
        print(f"AURA_LOADTEST_SUMMARY {json.dumps(result, ensure_ascii=False)}", flush=True)
    except BaseException as error:
        if isinstance(error, asyncio.CancelledError):
            raise
        print(f"AURA_SELFTEST_FATAL {type(error).__name__}: {error}", flush=True)


async def readiness_payload(request: Request) -> tuple[bool, dict[str, object]]:
    """Return backend readiness plus boot timing measured inside the container."""
    global MODEL_READY_AFTER_SECONDS

    uptime = time.monotonic() - STARTED_MONOTONIC
    try:
        result = await request.app.state.client.get(f"{BACKEND_HTTP}/health", timeout=1.0)
        is_ready = result.status_code == 200
    except httpx.HTTPError:
        is_ready = False

    voice_ready = not PRELOAD_VOICE
    voice_error: str | None = None
    if is_ready and PRELOAD_VOICE:
        if request.app.state.voice_preload_task is None:
            request.app.state.voice_preload_task = asyncio.create_task(
                preload_voice_and_warm(request.app)
            )
        voice_task = request.app.state.voice_preload_task
        if voice_task.done():
            try:
                voice_task.result()
                voice_ready = True
            except Exception as error:
                voice_error = f"{type(error).__name__}: {error}"
                request.app.state.voice_preload_task = None
        is_ready = voice_ready

    if is_ready and MODEL_READY_AFTER_SECONDS is None:
        MODEL_READY_AFTER_SECONDS = uptime

    return is_ready, {
        "status": "healthy" if is_ready else "starting",
        "ready": is_ready,
        "voice_ready": voice_ready,
        "voice": PRELOAD_VOICE_NAME if PRELOAD_VOICE else None,
        "voice_preload_error": voice_error,
        "gateway_started_at": STARTED_AT,
        "gateway_uptime_seconds": round(uptime, 3),
        "model_ready_after_seconds": (
            round(MODEL_READY_AFTER_SECONDS, 3) if MODEL_READY_AFTER_SECONDS is not None else None
        ),
    }


@app.get("/ping")
async def ping(request: Request) -> Response:
    """RunPod probe: 204 means initializing; 200 means inference is ready."""
    is_ready, payload = await readiness_payload(request)
    if is_ready:
        return JSONResponse(payload)
    return Response(status_code=204)


@app.get("/ready")
async def ready(request: Request) -> Response:
    """Readiness probe used by benchmarks and callers that need the model."""
    is_ready, payload = await readiness_payload(request)
    return JSONResponse(payload, status_code=200 if is_ready else 503)


def filtered_headers(headers: httpx.Headers) -> dict[str, str]:
    return {key: value for key, value in headers.items() if key.lower() not in HOP_BY_HOP}


def optimize_session_config(message: str) -> str:
    """Force the low-TTFA first chunk unless the caller chose another value."""
    try:
        payload = json.loads(message)
    except (TypeError, json.JSONDecodeError):
        return message
    if payload.get("type") != "session.config" or "initial_codec_chunk_frames" in payload:
        return message
    payload["initial_codec_chunk_frames"] = INITIAL_CODEC_CHUNK_FRAMES
    return json.dumps(payload, separators=(",", ":"))


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_http(path: str, request: Request) -> Response:
    client: httpx.AsyncClient = request.app.state.client
    upstream = client.build_request(
        request.method,
        f"{BACKEND_HTTP}/{path}",
        params=request.query_params,
        headers={key: value for key, value in request.headers.items() if key.lower() not in HOP_BY_HOP},
        content=await request.body(),
    )
    response = await client.send(upstream, stream=True)
    return StreamingResponse(
        response.aiter_raw(),
        status_code=response.status_code,
        headers=filtered_headers(response.headers),
        background=BackgroundTask(response.aclose),
    )


@app.websocket("/{path:path}")
async def proxy_websocket(path: str, client_ws: WebSocket) -> None:
    """Proxy vLLM's persistent incremental-text TTS WebSocket."""
    import websockets

    await client_ws.accept()
    try:
        async with websockets.connect(
            f"{BACKEND_WS}/{path}", max_size=None, compression=None
        ) as backend_ws:
            async def client_to_backend() -> None:
                while True:
                    message = await client_ws.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if message.get("text") is not None:
                        await backend_ws.send(optimize_session_config(message["text"]))
                    elif message.get("bytes") is not None:
                        await backend_ws.send(message["bytes"])

            async def backend_to_client() -> None:
                async for message in backend_ws:
                    if isinstance(message, bytes):
                        await client_ws.send_bytes(message)
                    else:
                        await client_ws.send_text(message)

            done, pending = await asyncio.wait(
                [asyncio.create_task(client_to_backend()), asyncio.create_task(backend_to_client())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
    except WebSocketDisconnect:
        return
