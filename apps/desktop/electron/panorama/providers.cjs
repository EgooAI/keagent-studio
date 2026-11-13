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
async function downloadMiniMaxVideo(value, file, signal) {
  const host = new URL(value).hostname;
  ensure(
    [
      "cdn.hailuoai.com",
      "video-product.cdn.minimax.io",
      "video-product.cdn.minimax.cn",
      "algeng-video-infer.oss-cn-shanghai.aliyuncs.com",
    ].includes(host),
    "MiniMax 视频下载域名无效",
  );
  const url = await publicURL(value);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
  });
  await fs.writeFile(file, await limitedBody(response, 32 * 1024 * 1024));
}
async function downloadImage(value, signal) {
  const host = new URL(value).hostname.toLowerCase();
  ensure(host.endsWith(".ljcdn.com"), "图片下载域名未授权");
  const url = await publicURL(value);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
  });
  return limitedBody(response, 50 * 1024 * 1024);
}
module.exports = {
  privateAddress,
  downloadMiniMaxVideo,
  downloadImage,
};
