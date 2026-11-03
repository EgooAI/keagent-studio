import { identity } from "../../../lib/auth.mjs";
import { authResponse } from "../../../lib/cors.mjs";
export const dynamic = "force-dynamic";
async function session(request) {
  const user = await identity(request.headers);
  return Response.json(user || { error: { message: "请重新登录" } }, {
    status: user ? 200 : 401,
    headers: { "Cache-Control": "no-store" },
  });
}
export const GET = (request) => authResponse(request, session);
export const OPTIONS = GET;
