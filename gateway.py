"""RunPod load-balancer health adapter and streaming reverse proxy for vLLM-Omni."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, StreamingResponse


BACKEND_HTTP = os.getenv("VLLM_BACKEND_URL", "http://127.0.0.1:8091").rstrip("/")
BACKEND_WS = BACKEND_HTTP.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
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


@app.get("/ping")
async def ping(request: Request) -> Response:
    """RunPod expects /ping; return 204 while vLLM is still loading."""
    try:
        result = await request.app.state.client.get(f"{BACKEND_HTTP}/health", timeout=1.0)
    except httpx.HTTPError:
        return Response(status_code=204)
    if result.status_code == 200:
        return JSONResponse({"status": "healthy"})
    return Response(status_code=204)


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
