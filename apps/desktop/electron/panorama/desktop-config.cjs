const fs = require("node:fs");
const path = require("node:path");
const domain = require("./domain.cjs");
const limit = 8192;

function validate(data) {
  const { revision, renderDefaults, catalogRefreshSeconds } = data;
  domain.ensure(Number.isSafeInteger(revision) && revision > 0, "配置版本无效");
  domain.ensure(
    Number.isInteger(catalogRefreshSeconds) &&
      catalogRefreshSeconds >= 30 &&
      catalogRefreshSeconds <= 3600,
    "目录刷新间隔无效",
  );
  domain.ensure(
    renderDefaults && typeof renderDefaults === "object",
    "缺少制作默认值",
  );
  return {
    revision,
    catalogRefreshSeconds,
    renderDefaults: domain.renderOverrides(renderDefaults) || {},
  };
}

// Refresh alongside the template directory. Offline clients use the last accepted revision.
function desktopConfig(origin, directory, request = fetch) {
  const file = path.join(directory, "desktop-config-v1.json");
  let current = { revision: 0, catalogRefreshSeconds: 60, renderDefaults: {} };
  try {
    current = validate(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    /* First launch or invalid cache. */
  }
  let nextCheck = 0;
  let pending;
  async function refresh() {
    const response = await request(
      new URL("/desktop-updates/config-v1.json", origin),
      {
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error("配置服务不可用");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error("配置文件过大");
      chunks.push(chunk);
    }
    const next = validate(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (next.revision <= current.revision) return;
    await fs.promises.writeFile(file + ".tmp", JSON.stringify(next), {
      mode: 0o600,
    });
    await fs.promises.rename(file + ".tmp", file);
    current = next;
  }
  return async () => {
    if (!pending && Date.now() >= nextCheck) {
      nextCheck = Date.now() + 30_000;
      pending = refresh()
        .catch(() => {})
        .finally(() => {
          pending = undefined;
        });
    }
    await pending;
    return current;
  };
}
module.exports = { desktopConfig };
