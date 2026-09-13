"""RunPod load-balancer health adapter and streaming reverse proxy for vLLM-Omni."""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, StreamingResponse


BACKEND_HTTP = os.getenv("VLLM_BACKEND_URL", "http://127.0.0.1:8091").rstrip("/")
BACKEND_WS = BACKEND_HTTP.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
STARTED_AT = datetime.now(timezone.utc).isoformat()
STARTED_MONOTONIC = time.monotonic()
MODEL_READY_AFTER_SECONDS: float | None = None
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
    try:
        yield
    finally:
        await app.state.client.aclose()


app = FastAPI(lifespan=lifespan)


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
