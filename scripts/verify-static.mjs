import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const start = fs.readFileSync(path.join(root, "start.sh"), "utf8");
const gateway = fs.readFileSync(path.join(root, "gateway.py"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

const assertions = [
  [start.includes("Qwen/Qwen3-TTS-12Hz-1.7B-Base"), "Base model is not pinned"],
  [start.includes("qwen3_tts.yaml"), "official deploy config is not used"],
  [start.includes("--task-type Base"), "Base task is not explicit"],
  [start.indexOf("python -m uvicorn") < start.indexOf("DEPLOY_CONFIG="), "liveness gateway must start before vLLM import"],
  [gateway.includes('@app.get("/ping")'), "RunPod health route is missing"],
  [gateway.includes('@app.get("/ready")'), "model readiness route is missing"],
  [gateway.includes('{"status": "starting", "ready": False}'), "liveness route does not stay healthy during model loading"],
  [gateway.includes("StreamingResponse"), "HTTP streaming proxy is missing"],
  [gateway.includes('@app.websocket("/{path:path}")'), "WebSocket proxy is missing"],
  [readme.includes("minimum 0, maximum 1"), "worker limits are not documented"],
  [readme.includes("GPU count: 1"), "single-GPU limit is not documented"],
];

for (const [ok, message] of assertions) {
  if (!ok) throw new Error(message);
}
console.log("static deployment contract verified");
