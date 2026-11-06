// Explicit manual test: submits ONE paid image expansion on its first run.
// Later runs restore checkpoints and query the same task without resubmitting.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const direct = process.argv.includes("--direct");
const output = path.join(
  root,
  direct
    ? "output/production-live-direct-verification"
    : "output/production-live-verification",
);
await mkdir(output, { recursive: true });
const settings = parseEnv(
  await readFile(path.join(root, ".env.local"), "utf8"),
);
assert.ok(
  settings.DASHSCOPE_API_KEY?.trim(),
  "Fill DASHSCOPE_API_KEY in this worktree's .env.local",
);
const directEnv = {
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
  NO_PROXY: "*",
  no_proxy: "*",
  NODE_USE_ENV_PROXY: "0",
};
Object.assign(process.env, directEnv);
for (const key of ["FFMPEG_PATH", "FFPROBE_PATH"])
  if (settings[key]) process.env[key] = settings[key];
const require = createRequire(import.meta.url);
const {
  PanoramaWorkflow,
} = require("../apps/desktop/electron/panorama/workflow.cjs");
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const media = require("../apps/desktop/electron/panorama/media.cjs");
const manifest = JSON.parse(
  await readFile(
    path.join(
      root,
      "output/property-samples/beike-official-pic-verify/manifest.json",
    ),
    "utf8",
  ),
);
const asset = manifest.assets.find((a) => a.fileName === "living-room-01.jpg");
const original = path.join(
  root,
  "output/property-samples/beike-official-pic-verify",
  asset.fileName,
);
assert.equal(
  domain.hash(await readFile(original)),
  asset.sha256,
  "Official sample checksum changed",
);
const database = new URL(settings.DATABASE_URL);
database.pathname = "/keagent_production_test";
const ready = path.join(output, `bridge-${randomUUID()}.json`);
const go = process.env.KEAGENT_GO_PATH || "go";
let bridgeLog = "";
const bridge = spawn(
  go,
  [
    "test",
    "-run",
    "^TestProductionSourcesLiveBridge$",
    "-count=1",
    "-timeout=17m",
  ],
  {
    cwd: path.join(root, "services/cloud"),
    windowsHide: true,
    env: {
      ...process.env,
      ...settings,
      ...directEnv,
      ADMIN_TEST_DATABASE_URL: database.href,
      KEAGENT_LIVE_SOURCE_BRIDGE: "1",
      KEAGENT_LIVE_SOURCE_READY_FILE: ready,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
bridge.on("error", (error) => {
  bridgeLog += error.code || "bridge failed";
});
for (const stream of [bridge.stdout, bridge.stderr])
  stream.on("data", (data) => {
    bridgeLog = (bridgeLog + data.toString()).slice(-4000);
  });
try {
  let endpoint;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      endpoint = JSON.parse(await readFile(ready, "utf8")).url;
      break;
    } catch {}
    if (bridge.exitCode !== null || bridgeLog.includes("ENOENT"))
      throw new Error(`Live bridge did not start: ${bridgeLog}`);
    await delay(500);
  }
  assert.ok(endpoint, "Live bridge startup timed out");
  const user = "production-live-smoke";
  const property = {
    id: "beike-official-photo-smoke",
    title: "贝壳官方示例客厅扩图测试",
    sample: true,
    areaSqm: 0,
    priceCents: 0,
    layout: "",
    description: "官方文档示例，不代表已通过贝壳授权接口查询。",
    sellingPoints: [],
  };
  async function remote(operation, input, signal) {
    if (operation === "beike-import")
      return {
        property,
        images: [
          {
            url: asset.sourceUrl,
            room: "示例客厅",
            description: "普通室内照片扩图流程测试。",
          },
        ],
        panoramas: [],
        panoramaAvailability: "not_exposed_by_this_interface",
      };
    const route = `/v1/panorama/${operation}`;
    const body = JSON.stringify(input);
    const context = Buffer.from(
      JSON.stringify({
        userId: user,
        sessionId: "manual-local-test",
        timestamp: Math.floor(Date.now() / 1000),
        nonce: randomUUID(),
      }),
    ).toString("base64url");
    const digest = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", settings.INTERNAL_API_SECRET)
      .update(`POST\n${route}\n${context}\n${digest}`)
      .digest("hex");
    const response = await fetch(endpoint + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keagent-Context": context,
        "X-Keagent-Signature": signature,
      },
      body,
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(65000),
      ]),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error?.message || `HTTP ${response.status}`);
    return result;
  }
  const workflow = new PanoramaWorkflow(
    path.join(output, "workflow"),
    "",
    {},
    remote,
  );
  const owner = workflow.owner(user);
  let state = workflow.store(owner);
  let imported = state.imports[property.id];
  if (!imported) imported = await workflow.handle(user, "beike-import", {});
  assert.equal(imported.materialMode, "expand");
  const scene = imported.scenes[0];
  assert.equal(
    scene.asset.split(".")[0],
    asset.sha256,
    "Downloaded Beike sample no longer matches the verified original",
  );
  assert.throws(() => workflow.scenes(owner, [scene]), /普通照片/);
  await copyFile(original, path.join(output, "original.jpg"));
  let task = state.imageTasks.find((t) => t.sceneId === scene.id);
  if (!task) {
    console.log(
      "Submitting one real Wanxiang expand task; request checkpoint is persisted before the paid call.",
    );
    await workflow.handle(user, "image-submit", {
      scene,
      prompt:
        "延展原图左右边缘的室内环境，延续墙面、地面、光照和透视，保留原有主体与水印，不添加门窗、家具或人物。",
      top_scale: 1,
      bottom_scale: 1,
      left_scale: 1.5,
      right_scale: 1.5,
    });
    task = state.imageTasks.find((t) => t.sceneId === scene.id);
  } else console.log("Restoring the existing task; no new generation request.");
  for (let attempt = 0; attempt < 100 && !task.result; attempt++) {
    await workflow.handle(user, "image-refresh", {});
    console.log(
      JSON.stringify({
        stage: "expansion",
        status: task.status,
        error: task.error,
      }),
    );
    if (task.error) throw new Error(task.error);
    if (!task.result) await delay(5000);
  }
  assert.ok(
    task.result,
    "Expansion still pending; rerun to query the original task",
  );
  const expanded = task.result;
  assert.throws(() => workflow.scenes(owner, [expanded]), /审核/);
  const query = await remote("image-query", { requestKey: task.id });
  const replay = await remote("image-submit", {
    requestKey: task.id,
    image: (
      await readFile(
        path.join(workflow.directory(owner), "assets", task.source.asset),
      )
    ).toString("base64"),
    ...task.parameters,
  });
  assert.equal(
    replay.taskId,
    query.taskId,
    "Request replay changed the paid vendor task",
  );
  assert.equal(replay.status, "SUCCEEDED");
  const resultFile = path.join(
    workflow.directory(owner),
    "assets",
    expanded.asset,
  );
  const extension = path.extname(resultFile);
  const previewFile = path.join(output, `expanded${extension}`);
  await copyFile(resultFile, previewFile);
  const info = await media.probe(previewFile, output);
  const dimensions = info.streams.find((s) => s.codec_type === "video");
  let previous = {};
  try {
    previous = JSON.parse(
      await readFile(path.join(output, "result.json"), "utf8"),
    );
  } catch {}
  const report = {
    ...previous,
    source: manifest.sourcePage,
    sample: true,
    model: task.model,
    requestKey: task.id,
    taskId: query.taskId,
    status: task.status,
    original: {
      file: path.join(output, "original.jpg"),
      width: scene.width,
      height: scene.height,
    },
    expanded: {
      file: previewFile,
      width: dimensions.width,
      height: dimensions.height,
    },
    gates: {
      rawPhotoBlocked: true,
      unreviewedOutputBlocked: true,
      repeatedSubmitReturnedSameTask: true,
    },
    note: "Real provider output. Visual review is required before video rendering.",
  };
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(ready + ".stop", "stop");
  for (let attempt = 0; attempt < 20 && bridge.exitCode === null; attempt++)
    await delay(250);
  if (bridge.exitCode === null) bridge.kill();
  await unlink(ready + ".stop").catch(() => {});
}
