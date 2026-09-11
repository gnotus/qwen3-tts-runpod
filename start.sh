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

# Importing vllm_omni installs runtime patches and writes informational messages
# to stdout. Keep only the final line containing the actual config path.
DEPLOY_CONFIG="$(python -c 'from pathlib import Path; import vllm_omni; print(Path(vllm_omni.__file__).resolve().parent / "deploy" / "qwen3_tts.yaml")' | tail -n 1)"

exec vllm serve "${MODEL}" \
  --omni \
  --task-type Base \
  --deploy-config "${DEPLOY_CONFIG}" \
  --host 127.0.0.1 \
  --port "${VLLM_PORT}"
