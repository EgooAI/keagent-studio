// ==UserScript==
// @name         贝壳 / 如视全景下载
// @namespace    keagent-studio
// @version      1.0.0
// @description  导出页面全景点位：六面源图、4096×2048 全景 JPG 和来源清单。
// @match        https://open.realsee.com/*
// @match        https://realsee.cn/*
// @match        https://*.realsee.cn/*
// @match        https://realsee.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";
  const FACES = ["right", "left", "up", "down", "front", "back"];
  const LIMIT = 256 * 1024 * 1024;

  function readPanoramas(roots, pageURL) {
    const points = new Map();
    const seen = new WeakSet();
    function walk(value, depth) {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 12)
        return;
      seen.add(value);
      if (Array.isArray(value.panorama?.list)) {
        const base = new URL(
          value.panorama.base_url || value.base_url || pageURL,
          pageURL,
        );
        for (const [ordinal, item] of value.panorama.list.entries()) {
          const urls = {};
          for (const face of FACES) {
            if (typeof item[face] !== "string" || !item[face])
              throw new Error(
                `点位 ${item.index ?? ordinal} 缺少 ${face} 图片`,
              );
            const url = new URL(item[face], base);
            if (url.protocol !== "https:")
              throw new Error("图片地址必须是 HTTPS");
            urls[face] = url.href;
          }
          points.set(urls.front, { index: item.index ?? ordinal, urls });
        }
        return;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    }
    for (const root of roots) walk(root, 0);
    return [...points.values()];
  }

  // Standard cubemap coordinates; image row zero is the top edge.
  function cubePixel(x, y, z, size) {
    const ax = Math.abs(x),
      ay = Math.abs(y),
      az = Math.abs(z);
    let face, u, v;
    if (ax >= ay && ax >= az) {
      face = x > 0 ? 0 : 1;
      u = (x > 0 ? -z : z) / ax;
      v = -y / ax;
    } else if (ay >= az) {
      face = y > 0 ? 2 : 3;
      u = x / ay;
      v = (y > 0 ? z : -z) / ay;
    } else {
      face = z > 0 ? 4 : 5;
      u = (z > 0 ? x : -x) / az;
      v = -y / az;
    }
    const px = Math.max(
      0,
      Math.min(size - 1, Math.floor(((u + 1) * size) / 2)),
    );
    const py = Math.max(
      0,
      Math.min(size - 1, Math.floor(((v + 1) * size) / 2)),
    );
    return [face, (py * size + px) * 4];
  }

  function zipStore(files) {
    if (files.length > 65535) throw new Error("ZIP 文件数过多");
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      table[n] = c >>> 0;
    }
    const parts = [],
      directory = [];
    let offset = 0,
      directorySize = 0;
    for (const file of files) {
      const name = new TextEncoder().encode(file.name);
      const bytes = file.bytes;
      let crc = 0xffffffff;
      for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
      crc = (crc ^ 0xffffffff) >>> 0;
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x800, true);
      lv.setUint16(12, 33, true); // DOS date: 1980-01-01.
      lv.setUint32(14, crc, true);
      lv.setUint32(18, bytes.length, true);
      lv.setUint32(22, bytes.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x800, true);
      cv.setUint16(14, 33, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, bytes.length, true);
      cv.setUint32(24, bytes.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      parts.push(local, bytes);
      directory.push(central);
      offset += local.length + bytes.length;
      directorySize += central.length;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, directorySize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], { type: "application/zip" });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { readPanoramas, cubePixel, zipStore };
    return;
  }
  if (document.getElementById("realsee-panorama-download")) return;

  function scan() {
    const roots = [];
    for (const script of document.querySelectorAll(
      'script[type="application/json"]',
    )) {
      const text = script.textContent
        .trim()
        .replace(/^<!--\s*/, "")
        .replace(/\s*-->$/, "");
      try {
        roots.push(JSON.parse(text));
      } catch {
        /* Other state blocks need not be JSON. */
      }
    }
    // shortcut: reads embedded Work JSON only; add a network adapter if the site stops embedding it.
    return readPanoramas(roots, location.href);
  }

  async function loadFace(url, signal) {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      credentials: "omit",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width !== bitmap.height || bitmap.width < 256)
        throw new Error(
          `不是完整正方形全景面：${bitmap.width}×${bitmap.height}`,
        );
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1024;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, 1024, 1024);
      return {
        blob,
        pixels: context.getImageData(0, 0, 1024, 1024).data,
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
    }
  }

  async function panoramaJpeg(faces, signal) {
    const canvas = document.createElement("canvas");
    canvas.width = 4096;
    canvas.height = 2048;
    const context = canvas.getContext("2d");
    const output = context.createImageData(canvas.width, canvas.height);
    const sin = [],
      cos = [];
    for (let col = 0; col < canvas.width; col++) {
      const angle = (((col + 0.5) / canvas.width) * 2 - 1) * Math.PI;
      sin.push(Math.sin(angle));
      cos.push(Math.cos(angle));
    }
    for (let row = 0; row < canvas.height; row++) {
      const latitude = (0.5 - (row + 0.5) / canvas.height) * Math.PI;
      const y = Math.sin(latitude),
        radius = Math.cos(latitude);
      for (let col = 0; col < canvas.width; col++) {
        const [face, source] = cubePixel(
          sin[col] * radius,
          y,
          cos[col] * radius,
          1024,
        );
        const target = (row * canvas.width + col) * 4;
        const pixels = faces[face].pixels;
        output.data[target] = pixels[source];
        output.data[target + 1] = pixels[source + 1];
        output.data[target + 2] = pixels[source + 2];
        output.data[target + 3] = 255;
      }
      if (row % 64 === 0) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    context.putImageData(output, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("全景 JPG 编码失败")),
        "image/jpeg",
        0.95,
      ),
    );
  }

  const host = document.createElement("div");
  host.id = "realsee-panorama-download";
  host.style.pointerEvents = "auto";
  const panel = host.attachShadow({ mode: "open" });
  panel.innerHTML = `<style>
    :host { position:fixed; right:16px; top:80px; z-index:2147483647; }
    section { box-sizing:border-box; width:min(310px,calc(100vw - 32px)); padding:16px; background:#fff; color:#222; border:1px solid #aaa; border-radius:8px; font:14px/1.6 system-ui,sans-serif; box-shadow:0 4px 18px #0003; }
    strong { font-size:16px; } p { margin:8px 0; } select { width:100%; margin:8px 0; } button, select { font:inherit; padding:6px 10px; } button { cursor:pointer; } button:disabled { cursor:default; } .actions { display:flex; gap:8px; } output { display:block; margin-top:8px; overflow-wrap:anywhere; } a { display:block; margin-top:8px; color:#0759ad; } [hidden] { display:none; }
  </style><section aria-label="全景下载工具">
    <strong>贝壳 / 如视全景下载</strong>
    <p>六面源图 + 4096×2048 全景 JPG</p>
    <label>下载范围<select aria-label="下载范围"></select></label>
    <div class="actions"><button id="download">生成 ZIP</button><button id="rescan">重新识别</button><button id="cancel" disabled>取消</button></div>
    <output aria-live="polite"></output><a hidden>保存 ZIP</a>
  </section>`;
  document.body.append(host);
  const select = panel.querySelector("select");
  const status = panel.querySelector("output");
  const download = panel.querySelector("#download");
  const rescan = panel.querySelector("#rescan");
  const cancel = panel.querySelector("#cancel");
  const save = panel.querySelector("a");
  let points = [],
    controller,
    objectURL;

  function refresh() {
    select.replaceChildren();
    try {
      points = scan();
      select.add(new Option(`全部 ${points.length} 个点位`, "all"));
      points.forEach((point, index) =>
        select.add(new Option(`点位 ${point.index}`, String(index))),
      );
      status.textContent = points.length
        ? `已识别 ${points.length} 个点位，${points.length * 6} 张源图。`
        : "未找到全景数据。等待 VR 加载后点击重新识别。";
    } catch (error) {
      points = [];
      status.textContent = error.message;
    }
    download.disabled = !points.length;
  }

  cancel.onclick = () => controller?.abort();
  rescan.onclick = refresh;
  download.onclick = async () => {
    controller = new AbortController();
    const signal = controller.signal;
    download.disabled = rescan.disabled = select.disabled = true;
    cancel.disabled = false;
    save.hidden = true;
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
      objectURL = undefined;
    }
    const chosen =
      select.value === "all" ? points : [points[Number(select.value)]];
    const files = [],
      results = [];
    let bytes = 0;
    const add = async (name, blob) => {
      if (bytes + blob.size > LIMIT)
        throw new Error("ZIP 超过 256 MiB，请改为单点位下载");
      const data = new Uint8Array(await blob.arrayBuffer());
      files.push({ name, bytes: data });
      bytes += data.length;
    };
    try {
      for (const [ordinal, point] of chosen.entries()) {
        signal.throwIfAborted();
        const folder = `pano-${String(ordinal + 1).padStart(3, "0")}`;
        const result = {
          index: point.index,
          folder,
          sources: [],
          panorama: null,
          error: null,
        };
        results.push(result);
        try {
          const faces = [];
          for (const face of FACES) {
            status.textContent = `点位 ${ordinal + 1}/${chosen.length}：下载 ${face}…`;
            const image = await loadFace(point.urls[face], signal);
            const extensions = {
              "image/avif": "avif",
              "image/webp": "webp",
              "image/png": "png",
              "image/jpeg": "jpg",
            };
            const extension = extensions[image.blob.type] || "img";
            const file = `${folder}/${face}.${extension}`;
            await add(file, image.blob);
            result.sources.push({
              face,
              url: point.urls[face],
              file,
              width: image.width,
              height: image.height,
            });
            faces.push(image);
          }
          if (faces.some((face) => face.width !== faces[0].width))
            throw new Error("六面图片尺寸不一致");
          status.textContent = `点位 ${ordinal + 1}/${chosen.length}：生成全景 JPG…`;
          const file = `${folder}/panorama-4096x2048.jpg`;
          await add(file, await panoramaJpeg(faces, signal));
          result.panorama = {
            file,
            projection: "equirectangular",
            width: 4096,
            height: 2048,
          };
        } catch (error) {
          if (
            signal.aborted ||
            bytes >= LIMIT ||
            error.message.includes("256 MiB")
          )
            throw error;
          result.error = error.message;
        }
      }
      signal.throwIfAborted();
      const complete = results.filter((result) => result.panorama).length;
      const manifest = {
        source: location.href,
        title: document.title,
        exportedAt: new Date().toISOString(),
        complete,
        requested: chosen.length,
        results,
      };
      await add(
        "manifest.json",
        new Blob([JSON.stringify(manifest, null, 2)], {
          type: "application/json",
        }),
      );
      objectURL = URL.createObjectURL(zipStore(files));
      save.href = objectURL;
      save.download = `${document.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)}-VR.zip`;
      save.hidden = false;
      status.textContent = `${complete === chosen.length ? "已完成" : "部分失败"}：${complete}/${chosen.length} 个全景 JPG。${complete < chosen.length ? "错误见 ZIP 内 manifest.json。" : ""}点击下方保存 ZIP。`;
    } catch (error) {
      status.textContent = signal.aborted
        ? "已取消，可重新生成。"
        : `导出失败：${error.message}`;
    } finally {
      download.disabled = rescan.disabled = select.disabled = false;
      cancel.disabled = true;
    }
  };
  refresh();
})();
