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


async def run_selftest_when_ready(app: FastAPI) -> None:
    prompts = [
        {"language": "English", "text": "Hello, I am Aura. How can I help you today?"},
        {"language": "Spanish", "text": "Hola, soy Aura. ¿Cómo puedo ayudarte hoy?"},
        {"language": "Portuguese", "text": "Olá, eu sou a Aura. Como posso ajudar você hoje?"},
        {
            "language": "English",
            "text": "I found the information. Let me explain it clearly and briefly.",
        },
    ]
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
        shared_start = time.monotonic()
        settled = await asyncio.gather(
            *(
                run_selftest_stream(app.state.client, item, index, reference_audio, shared_start)
                for index, item in enumerate(prompts)
            ),
            return_exceptions=True,
        )
        wall_seconds = time.monotonic() - shared_start
        streams = [result for result in settled if isinstance(result, dict)]
        failures = [
            {
                "stream": index + 1,
                "language": prompts[index]["language"],
                "error": str(result),
            }
            for index, result in enumerate(settled)
            if isinstance(result, BaseException)
        ]
        aggregate_audio_seconds = sum(float(result["audio_seconds"]) for result in streams)
        ttfas = sorted(float(result["ttfa_seconds"]) for result in streams)
        test_cost = wall_seconds / 3_600 * SELFTEST_GPU_HOURLY_USD
        result = {
            "concurrency_requested": 4,
            "completed": len(streams),
            "failed": len(failures),
            "wall_seconds": round(wall_seconds, 3),
            "aggregate_audio_seconds": round(aggregate_audio_seconds, 3),
            "aggregate_audio_realtime_multiple": (
                round(aggregate_audio_seconds / wall_seconds, 3) if wall_seconds else None
            ),
            "ttfa_p50_seconds": ttfas[1] if len(ttfas) == 4 else None,
            "ttfa_p95_seconds": ttfas[-1] if ttfas else None,
            "gpu_hourly_usd": SELFTEST_GPU_HOURLY_USD,
            "estimated_test_cost_usd": round(test_cost, 6),
            "estimated_cost_per_generated_audio_hour_usd": (
                round(test_cost / (aggregate_audio_seconds / 3_600), 3)
                if aggregate_audio_seconds
                else None
            ),
            "model_ready_after_seconds": round(backend_ready_after_seconds, 3),
            "selftest_completed_after_seconds": round(
                time.monotonic() - STARTED_MONOTONIC, 3
            ),
            "streams": streams,
            "failures": failures,
        }
        print(f"AURA_SELFTEST_RESULT {json.dumps(result, ensure_ascii=False)}", flush=True)
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

    if is_ready and MODEL_READY_AFTER_SECONDS is None:
        MODEL_READY_AFTER_SECONDS = uptime

    return is_ready, {
        "status": "healthy" if is_ready else "starting",
        "ready": is_ready,
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
        async with websockets.connect(f"{BACKEND_WS}/{path}", max_size=None) as backend_ws:
            async def client_to_backend() -> None:
                while True:
                    message = await client_ws.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if message.get("text") is not None:
                        await backend_ws.send(message["text"])
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
