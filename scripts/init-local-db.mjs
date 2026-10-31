import { loadEnvFile } from "node:process";
import pg from "pg";
loadEnvFile(".env.local");
const url = new URL(process.env.DATABASE_URL);
if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "55432" ||
  url.pathname !== "/keagent"
)
  throw new Error("仅初始化本项目的本机数据库");
url.pathname = "/postgres";
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  const result = await client.query(
    "SELECT 1 FROM pg_database WHERE datname=$1",
    ["keagent"],
  );
  if (!result.rowCount) await client.query("CREATE DATABASE keagent");
} finally {
  await client.end();
}
