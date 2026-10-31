import { identity } from "../../../lib/auth.mjs";
export const dynamic = "force-dynamic";
export async function GET(request) {
  const user = await identity(request.headers);
  return Response.json(user || { error: { message: "请重新登录" } }, {
    status: user ? 200 : 401,
    headers: { "Cache-Control": "no-store" },
  });
}
