#!/usr/bin/env bash
set -euo pipefail

MODEL="${MODEL:-Qwen/Qwen3-TTS-12Hz-1.7B-Base}"
PUBLIC_PORT="${PORT:-8000}"
VLLM_PORT="${VLLM_PORT:-8091}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export VLLM_BACKEND_URL="http://127.0.0.1:${VLLM_PORT}"

# Start RunPod's liveness endpoint before importing vLLM-Omni. That import is
# expensive enough for the platform health checker to launch replacements if
# port 8000 is still closed.
python -m uvicorn gateway:app \
  --app-dir "${SCRIPT_DIR}" \
  --host 0.0.0.0 \
  --port "${PUBLIC_PORT}" \
  --log-level info &
gateway_pid=$!

cleanup() {
  kill -TERM "${gateway_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Locate the package without importing vllm_omni twice. The real import is left
# to `vllm serve`, avoiding duplicate initialization on the startup path.
DEPLOY_CONFIG="$(python -c 'from importlib.util import find_spec; from pathlib import Path; spec = find_spec("vllm_omni"); assert spec and spec.submodule_search_locations; print(Path(next(iter(spec.submodule_search_locations))) / "deploy" / "qwen3_tts.yaml")')"

exec vllm serve "${MODEL}" \
  --omni \
  --task-type Base \
  --deploy-config "${DEPLOY_CONFIG}" \
  --host 127.0.0.1 \
  --port "${VLLM_PORT}"
