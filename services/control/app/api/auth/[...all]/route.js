import { getAuth } from "../../../../lib/auth.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request) => getAuth().handler(request);
export const POST = (request) => getAuth().handler(request);
