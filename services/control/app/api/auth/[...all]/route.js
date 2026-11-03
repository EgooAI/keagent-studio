import { getAuth } from "../../../../lib/auth.mjs";
import { authResponse } from "../../../../lib/cors.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request) =>
  authResponse(request, (value) => getAuth().handler(value));
export const POST = GET;
export const OPTIONS = GET;
