const fs = require("node:fs/promises");
const dns = require("node:dns/promises");
const net = require("node:net");
const { ensure } = require("./domain.cjs");
function privateAddress(address) {
  const lower = address.toLowerCase();
  if (net.isIP(address) === 6)
    return (
      lower === "::1" ||
      lower === "::" ||
      /^(fc|fd|fe[89ab])/.test(lower) ||
      lower.startsWith("::ffff:")
    );
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
function avatarResult(data) {
  const detail =
    typeof data?.resp_data === "string"
      ? JSON.parse(data.resp_data)
      : data?.resp_data;
  if (detail?.code !== undefined)
    ensure(detail.code === 0, `数字人处理失败，code=${detail.code}`);
  const url = data?.video_url || detail?.url || detail?.vid?.url;
  return { status: data?.status || (url ? "done" : "processing"), url };
}
async function publicURL(value) {
  const url = new URL(value);
  ensure(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443"),
    "供应商地址必须为 HTTPS",
  );
  const addresses = await dns.lookup(url.hostname, { all: true });
  ensure(
    addresses.length && addresses.every((a) => !privateAddress(a.address)),
    "供应商地址不能指向内网",
  );
  return url;
}
async function limitedBody(response, limit = 2 * 1024 * 1024) {
  ensure(response.ok, `供应商 HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error("供应商响应过大");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function downloadVideo(value, file, signal, env = process.env) {
  // Only documented vendor CDNs or operator-approved hosts; never follow redirects with signed URLs.
  const host = new URL(value).hostname;
  const approved = (env.VOLC_VIDEO_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim());
  ensure(
    /\.(volces\.com|volccdn\.com|byteimg\.com|yangyi08\.com)$/.test(host) ||
      approved.includes(host),
    "数字人视频域名未授权，请配置 VOLC_VIDEO_ALLOWED_HOSTS",
  );
  const url = await publicURL(value);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  await fs.writeFile(file, await limitedBody(response, 256 * 1024 * 1024));
}
module.exports = { avatarResult, privateAddress, downloadVideo };
