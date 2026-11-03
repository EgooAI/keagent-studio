export async function authResponse(request, handle) {
  const origin = request.headers.get("origin");
  const allowed = (
    process.env.TRUSTED_ORIGINS || "http://127.0.0.1:5174,http://127.0.0.1:5173"
  )
    .split(",")
    .map((value) => value.trim());
  const ownOrigin = new URL(
    process.env.BETTER_AUTH_URL || "http://127.0.0.1:18080",
  ).origin;
  if (origin && origin !== ownOrigin && !allowed.includes(origin))
    return Response.json(
      { error: { message: "请求来源无效" } },
      { status: 403 },
    );
  if (request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    const headers = (
      request.headers.get("access-control-request-headers") || ""
    ).split(",");
    if (
      !origin ||
      !["GET", "POST"].includes(method) ||
      headers.some(
        (header) =>
          !["", "content-type", "authorization"].includes(
            header.trim().toLowerCase(),
          ),
      )
    )
      return new Response(null, { status: 403 });
  }
  const response =
    request.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : await handle(request);
  response.headers.append("Vary", "Origin");
  response.headers.set("Cache-Control", "no-store");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }
  return response;
}
