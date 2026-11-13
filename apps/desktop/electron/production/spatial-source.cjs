const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const dns = require("node:dns/promises");
const domain = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const { privateAddress } = require("../panorama/providers.cjs");

const faces = ["right", "left", "up", "down", "front", "back"];
const maxBytes = 200 * 1024 * 1024;
function sourceURL(value, asset = false, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error("VR 链接无效");
  }
  const allowed = asset
    ? ["vr-public.realsee-cdn.cn"]
    : [
        "open.realsee.com",
        "realsee.cn",
        "www.realsee.cn",
        "realsee.com",
        "www.realsee.com",
      ];
  domain.ensure(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      allowed.includes(url.hostname),
    asset
      ? "VR 素材下载域名不受支持"
      : "目前仅支持公开的如视 VR 原始链接，请填写完整 HTTPS 地址",
  );
  return url;
}

async function download(value, signal, budget, limit, asset = false, base) {
  const url = sourceURL(value, asset, base);
  const addresses = await dns.lookup(url.hostname, { all: true });
  domain.ensure(
    addresses.length &&
      addresses.every(({ address }) => !privateAddress(address)),
    "VR 下载地址不能指向内网",
  );
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        headers: {
          "User-Agent": "KeAgent-Studio/0.1",
          "Accept-Encoding": "identity",
        },
        // Pin the checked DNS result so the HTTPS connection cannot resolve a different address.
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, addresses)
            : callback(null, addresses[0].address, addresses[0].family),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `VR 下载失败（HTTP ${response.statusCode}）；请使用无需登录或跳转的公开链接`,
            ),
          );
          return;
        }
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          budget.bytes += chunk.length;
          if (length > limit || budget.bytes > maxBytes) {
            response.destroy(new Error("VR 素材超过导入大小限制"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    request.on("error", reject);
  });
}

function parseWork(html) {
  let found;
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 16 || found) return;
    if (
      Array.isArray(value.observers) &&
      Array.isArray(value.panorama?.list) &&
      value.model
    ) {
      found = value;
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  for (const match of html.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    try {
      visit(
        JSON.parse(
          match[1]
            .trim()
            .replace(/^<!--\s*/, "")
            .replace(/\s*-->$/, ""),
        ),
      );
    } catch {}
    if (found) break;
  }
  domain.ensure(
    found,
    "该 VR 链接未提供可导入的公开空间模型，请确认链接或改用其他如视房源",
  );
  return found;
}

const vector = (value) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(
    (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100000,
  );
const pointID = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
function normalizeWork(raw, pageURL) {
  domain.ensure(
    raw?.model?.type === 0 &&
      raw?.panorama?.type === 0 &&
      Array.isArray(raw.observers) &&
      raw.observers.length >= 2 &&
      raw.observers.length <= 20 &&
      Array.isArray(raw.panorama.list) &&
      raw.panorama.list.length === raw.observers.length,
    "空间模型格式不受支持；需要 2–20 个带位置的原始全景点位",
  );
  domain.ensure(
    typeof raw.code === "string" && /^[\w-]{1,160}$/.test(raw.code),
    "VR 空间标识无效",
  );
  const observers = raw.observers.map((o) => {
    const q = o.quaternion;
    domain.ensure(
      pointID(o.index) &&
        vector(o.position) &&
        q &&
        [q.w, q.x, q.y, q.z].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        ) &&
        Math.abs(Math.hypot(q.w, q.x, q.y, q.z) - 1) < 0.01,
      "VR 点位坐标或旋转数据无效",
    );
    domain.ensure(
      Array.isArray(o.accessible_nodes) &&
        o.accessible_nodes.length <= 20 &&
        o.accessible_nodes.every(pointID),
      "VR 可达点位数据无效",
    );
    return {
      index: o.index,
      position: [...o.position],
      quaternion: { w: q.w, x: q.x, y: q.y, z: q.z },
      accessible_nodes: [...new Set(o.accessible_nodes)],
      visible_nodes: Array.isArray(o.visible_nodes)
        ? o.visible_nodes.filter(pointID)
        : [],
      ...(vector(o.standing_position)
        ? { standing_position: [...o.standing_position] }
        : {}),
      floor_index: Number.isSafeInteger(o.floor_index) ? o.floor_index : 0,
    };
  });
  const indices = new Set(observers.map((o) => o.index));
  domain.ensure(indices.size === observers.length, "VR 点位编号重复");
  for (const o of observers) {
    domain.ensure(
      o.accessible_nodes.every((index) => indices.has(index)),
      "VR 可达点位不存在",
    );
    o.visible_nodes = o.visible_nodes.filter((index) => indices.has(index));
  }
  const assets = [];
  function asset(value, name, base, model = false) {
    const url = sourceURL(value, true, base).href;
    const extension = model
      ? ".at3d"
      : path.extname(new URL(url).pathname).toLowerCase();
    domain.ensure(
      model
        ? /\.at3d$/i.test(new URL(url).pathname)
        : [".jpg", ".jpeg", ".png", ".webp", ".avif"].includes(extension),
      "VR 素材格式不受支持",
    );
    const file = name + extension;
    assets.push({ source: url, file, model });
    return file;
  }
  domain.ensure(
    Array.isArray(raw.model.material_textures) &&
      raw.model.material_textures.length >= 1 &&
      raw.model.material_textures.length <= 16,
    "VR 模型纹理缺失或过多",
  );
  const model = {
    type: 0,
    file_url: asset(raw.model.file_url, "model", pageURL, true),
    material_base_url: "./",
    material_textures: raw.model.material_textures.map((url, i) =>
      asset(url, `texture_${i}`, raw.model.material_base_url || pageURL),
    ),
  };
  const seen = new Set();
  const list = raw.panorama.list.map((p) => {
    domain.ensure(
      pointID(p.index) && indices.has(p.index) && !seen.has(p.index),
      "VR 全景与点位编号不匹配",
    );
    seen.add(p.index);
    return {
      index: p.index,
      ...Object.fromEntries(
        faces.map((face) => {
          domain.ensure(
            typeof p[face] === "string" && p[face],
            "VR 全景缺少六面原图",
          );
          return [
            face,
            asset(
              p[face],
              `pano-${p.index}-${face}`,
              raw.panorama.base_url || pageURL,
            ),
          ];
        }),
      ),
      hdr: false,
      size_list: [2048],
    };
  });
  for (const observer of observers) {
    domain.ensure(
      targetsFor(observers, observer.index).length,
      `点位 ${observer.index} 没有可移动的相邻位置`,
    );
  }
  const first =
    observers.find((o) => o.index === raw.initial?.pano_index) || observers[0];
  return {
    work: {
      code: raw.code,
      model,
      observers,
      panorama: {
        type: 0,
        base_url: "./",
        count: list.length,
        work_code: raw.code,
        list,
      },
      initial: {
        mode: "Panorama",
        pano: first.index,
        panoIndex: first.index,
        pano_index: first.index,
        longitude: 0,
        latitude: 0,
        fov: 84,
        offset: {
          x: first.position[0],
          y: first.position[1],
          z: first.position[2],
        },
        distance: 0,
      },
    },
    assets,
  };
}

function targetsFor(observers, index) {
  const source = observers.find((o) => o.index === index);
  if (!source) return [];
  return observers
    .filter(
      (o) => o.index !== index && source.accessible_nodes.includes(o.index),
    )
    .map((o) => ({
      observer: o,
      distance: Math.hypot(...o.position.map((n, i) => n - source.position[i])),
    }))
    .filter(({ distance }) => distance > 0.05)
    .sort(
      (a, b) => a.distance - b.distance || a.observer.index - b.observer.index,
    )
    .map(({ observer }) => ({
      index: observer.index,
      label: `点位 ${observer.index + 1}`,
    }));
}

// Draft metadata is untrusted: derive its graph and image association from the
// immutable, content-addressed import instead of accepting the caller's targets.
function validateSpatialScene(ownerDir, scene) {
  if (!scene.spatial) return undefined;
  const { workId, panoIndex, targetPanoIndex } = scene.spatial;
  domain.ensure(
    typeof workId === "string" &&
      /^[a-f0-9]{64}$/.test(workId) &&
      pointID(panoIndex) &&
      pointID(targetPanoIndex),
    "空间模型或点位标识无效",
  );
  const file = path.join(ownerDir, "spatial", workId, "work.json");
  domain.ensure(fsSync.existsSync(file), "空间模型不存在，请重新导入 VR 链接");
  domain.ensure(
    fsSync.statSync(file).size <= 8 * 1024 * 1024,
    "空间模型数据过大",
  );
  const json = fsSync.readFileSync(file);
  domain.ensure(
    domain.hash(json) === workId,
    "空间模型校验失败，请重新导入 VR 链接",
  );
  const work = JSON.parse(json.toString("utf8"));
  domain.ensure(
    work._keagent?.schemaVersion === 1 &&
      Array.isArray(work.observers) &&
      Array.isArray(work._keagent.panoramas) &&
      work._keagent.panoramas.some(
        (p) => p.index === panoIndex && p.asset === scene.asset,
      ),
    "全景图片与空间点位不匹配，请重新选择素材",
  );
  const targets = targetsFor(work.observers, panoIndex);
  domain.ensure(
    targets.some((t) => t.index === targetPanoIndex),
    "目标点位不可达或位置相同",
  );
  return { workId, panoIndex, targetPanoIndex, targets };
}

async function importProperty(workflow, owner, property, input, assertCurrent) {
  domain.ensure(
    property && property.id === input.propertyId && !property.sample,
    "房源不存在或不支持导入空间，请重新选择",
  );
  const source = sourceURL(property.details?.vrUrl).href;
  const controller = new AbortController();
  workflow.previews.add(controller);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(5 * 60 * 1000),
  ]);
  const base = path.resolve(workflow.directory(owner), "spatial");
  await fs.mkdir(base, { recursive: true });
  const temp = await fs.mkdtemp(path.join(base, ".import-"));
  try {
    const budget = { bytes: 0 };
    const html = await module.exports.download(
      source,
      signal,
      budget,
      8 * 1024 * 1024,
    );
    const { work, assets } = normalizeWork(
      parseWork(html.toString("utf8")),
      source,
    );
    let next = 0;
    const downloads = Array.from({ length: 4 }, async () => {
      for (;;) {
        const index = next++;
        if (index >= assets.length) return;
        const asset = assets[index];
        const bytes = await module.exports.download(
          asset.source,
          signal,
          budget,
          32 * 1024 * 1024,
          true,
        );
        domain.ensure(bytes.length > 32, "VR 素材为空或损坏");
        await fs.writeFile(path.join(temp, asset.file), bytes);
        Object.assign(asset, {
          sha256: domain.hash(bytes),
          bytes: bytes.length,
        });
        if (!asset.model) {
          const info = await media.probe(asset.file, temp, signal);
          const stream = info.streams.find((s) => s.codec_type === "video");
          domain.ensure(
            stream &&
              stream.width >= 256 &&
              stream.height >= 256 &&
              stream.width <= 8192 &&
              stream.height <= 8192,
            "VR 图片尺寸无效",
          );
          asset.width = stream.width;
          asset.height = stream.height;
        }
        assertCurrent();
      }
    });
    try {
      await Promise.all(downloads);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(downloads);
      throw error;
    }
    const converted = [];
    for (const pano of work.panorama.list) {
      const images = faces.map((face) =>
        assets.find((a) => a.file === pano[face]),
      );
      domain.ensure(
        images.every(
          (a) => a.width === a.height && a.width === images[0].width,
        ),
        "VR 六面图尺寸不一致",
      );
      pano.size_list = [images[0].width];
      const file = `panorama-${pano.index}.jpg`;
      await media.run(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          ...images.flatMap((a) => ["-i", a.file]),
          "-filter_complex",
          "[0:v][1:v][2:v][3:v][4:v][5:v]hstack=inputs=6,v360=input=c6x1:in_forder=rludfb:output=e:w=4096:h=2048",
          "-frames:v",
          "1",
          "-q:v",
          "2",
          file,
        ],
        temp,
        signal,
      );
      const bytes = await fs.readFile(path.join(temp, file));
      converted.push({
        index: pano.index,
        file,
        asset: `${domain.hash(bytes)}.jpg`,
      });
      assertCurrent();
    }
    work._keagent = {
      schemaVersion: 1,
      assets: assets.map(({ file, sha256, bytes }) => ({
        file,
        sha256,
        bytes,
      })),
      panoramas: converted.map(({ index, asset }) => ({ index, asset })),
    };
    const json = JSON.stringify(work, null, 2) + "\n";
    const workId = domain.hash(json);
    const destination = path.join(base, workId);
    const scenes = [];
    for (const pano of converted) {
      const scene = await workflow.importBytes(
        owner,
        await fs.readFile(path.join(temp, pano.file)),
        `点位 ${pano.index + 1}`,
        "panorama",
      );
      const targets = targetsFor(work.observers, pano.index);
      const from = work.observers.find((o) => o.index === pano.index).position;
      const to = work.observers.find(
        (o) => o.index === targets[0].index,
      ).position;
      const uuid = domain.hash(["spatial-scene", workId, pano.index]);
      scenes.push({
        ...scene,
        id: `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-5${uuid.slice(13, 16)}-8${uuid.slice(17, 20)}-${uuid.slice(20, 32)}`,
        yaw:
          (Math.atan2(-(to[0] - from[0]), -(to[2] - from[2])) * 180) /
            Math.PI || 0,
        spatial: {
          workId,
          panoIndex: pano.index,
          targetPanoIndex: targets[0].index,
          targets,
        },
      });
      assertCurrent();
    }
    await fs.writeFile(path.join(temp, "work.json"), json);
    await fs.writeFile(
      path.join(temp, "source.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          source,
          workId,
          workCode: work.code,
          fetchedAt: new Date().toISOString(),
          assets,
        },
        null,
        2,
      ) + "\n",
    );
    try {
      const existing = await fs.readFile(path.join(destination, "work.json"));
      domain.ensure(
        domain.hash(existing) === workId,
        "已导入的空间模型已改变，请检查本机素材",
      );
      for (const asset of assets)
        domain.ensure(
          domain.hash(await fs.readFile(path.join(destination, asset.file))) ===
            asset.sha256,
          "已导入的空间素材已改变",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.rename(temp, destination);
    }
    const state = workflow.store(owner);
    const previous = state.imports[property.id];
    domain.ensure(
      scenes.length + (previous?.references?.length || 0) <= 20,
      "VR 点位与参考图合计不能超过20张",
    );
    const previousProperties = state.properties;
    signal.throwIfAborted();
    assertCurrent();
    state.imports[property.id] = {
      ...previous,
      property: structuredClone(property),
      scenes,
      materialMode: "panorama",
      spatial: { workId, source },
      remoteFingerprint: undefined,
      remoteSceneIds: undefined,
    };
    state.properties = [
      property,
      ...state.properties.filter((p) => p.id !== property.id),
    ];
    try {
      workflow.persist(owner);
    } catch (error) {
      if (previous) state.imports[property.id] = previous;
      else delete state.imports[property.id];
      state.properties = previousProperties;
      throw error;
    }
    return { count: scenes.length, scenes, workId };
  } finally {
    controller.abort();
    workflow.previews.delete(controller);
    domain.ensure(
      path.resolve(temp).startsWith(base + path.sep),
      "导入临时路径无效",
    );
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = {
  sourceURL,
  download,
  parseWork,
  normalizeWork,
  targetsFor,
  validateSpatialScene,
  importProperty,
};
