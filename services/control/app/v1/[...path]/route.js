import { createHash, createHmac, randomUUID } from "node:crypto";
import { identity } from "../../../lib/auth.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request) {
  const user = await identity(request.headers);
  if (!user)
    return Response.json(
      { error: { message: "请重新登录", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/v1/admin/") &&
    !user.role.split(",").includes("admin")
  )
    return Response.json(
      { error: { message: "需要管理员权限" } },
      { status: 403 },
    );
  // Cookie 请求保持同源校验；桌面仅接受 Main 发出的 Bearer 请求。
  if (request.method !== "GET" && !request.headers.has("authorization")) {
    const origin = request.headers.get("origin");
    const allowed = (
      process.env.TRUSTED_ORIGINS ||
      "http://127.0.0.1:5174,http://127.0.0.1:5173"
    ).split(",");
    if (!origin || !allowed.includes(origin))
      return Response.json(
        { error: { message: "请求来源无效" } },
        { status: 403 },
      );
  }
  if (Number(request.headers.get("content-length") || 0) > 1048576)
    return new Response(null, { status: 413 });
  const chunks = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 1048576) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(chunk.value);
    }
  }
  const body = Buffer.concat(chunks);
  const context = Buffer.from(
    JSON.stringify({
      ...user,
      deviceId: request.headers.get("X-Keagent-Device") || "",
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
    }),
  ).toString("base64url");
  const target = url.pathname + url.search;
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", process.env.INTERNAL_API_SECRET)
    .update(`${request.method}\n${target}\n${context}\n${digest}`)
    .digest("hex");
  try {
    const upstream = await fetch(
      `${process.env.GO_API_URL || "http://127.0.0.1:18081"}${target}`,
      {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          "X-Keagent-Context": context,
          "X-Keagent-Signature": signature,
        },
        body: request.method === "GET" ? undefined : body,
        signal: AbortSignal.timeout(65000),
        redirect: "error",
      },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: { message: "业务服务暂不可用", code: "UPSTREAM_UNAVAILABLE" } },
      { status: 503 },
    );
  }
}
export const GET = handle;
export const POST = handle;
