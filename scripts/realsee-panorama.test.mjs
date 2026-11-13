import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("./realsee-panorama.user.js", import.meta.url),
  "utf8",
);
const sandbox = { module: { exports: {} }, URL, Blob, TextEncoder };
vm.runInNewContext(source, sandbox);
const { readPanoramas, cubePixel, zipStore } = sandbox.module.exports;
const faces = ["right", "left", "up", "down", "front", "back"];
const point = {
  index: 2,
  ...Object.fromEntries(faces.map((face) => [face, `images/2_${face}.avif`])),
};

test("reads nested page Work with panorama base URL and deduplicates point URLs", () => {
  const work = {
    panorama: { base_url: "https://cdn.example/vr/", list: [point] },
  };
  const result = readPanoramas(
    [{ firstscreen: { defaultWork: work } }, work],
    "https://open.realsee.com/ke/test/",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].index, 2);
  assert.equal(
    result[0].urls.front,
    "https://cdn.example/vr/images/2_front.avif",
  );
});

test("supports Work-level bases, absolute images, and cyclic data", () => {
  const work = {
    base_url: "https://cdn.example/",
    panorama: { list: [{ ...point, up: "https://other.example/up.jpg" }] },
  };
  const root = { work };
  root.self = root;
  const result = readPanoramas([root], "https://open.realsee.com/");
  assert.equal(result[0].urls.up, "https://other.example/up.jpg");
  assert.equal(result[0].urls.down, "https://cdn.example/images/2_down.avif");
  assert.equal(
    readPanoramas([{ panorama: [] }], "https://open.realsee.com/").length,
    0,
  );
});

test("rejects missing faces and non-HTTPS source URLs", () => {
  for (const replacement of [{ front: "" }, { front: "javascript:alert(1)" }]) {
    assert.throws(() =>
      readPanoramas(
        [{ panorama: { list: [{ ...point, ...replacement }] } }],
        "https://open.realsee.com/",
      ),
    );
  }
});

test("cube axes map to face centers; every sampled direction stays inside its face", () => {
  for (const [index, direction] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ].entries()) {
    assert.deepEqual(Array.from(cubePixel(...direction, 8)), [
      index,
      (4 * 8 + 4) * 4,
    ]);
  }
  for (let row = 0; row < 36; row++)
    for (let col = 0; col < 72; col++) {
      const lat = (0.5 - row / 36) * Math.PI,
        lon = (col / 72) * Math.PI * 2;
      const [face, offset] = cubePixel(
        Math.sin(lon) * Math.cos(lat),
        Math.sin(lat),
        Math.cos(lon) * Math.cos(lat),
        16,
      );
      assert.ok(face >= 0 && face < 6);
      assert.ok(offset >= 0 && offset < 16 * 16 * 4 && offset % 4 === 0);
    }
  assert.equal(cubePixel(1, 0, 0.5, 16)[1], (8 * 16 + 4) * 4);
  assert.equal(cubePixel(0.5, 1, 0.5, 16)[1], (12 * 16 + 12) * 4);
});

test("ZIP has standard headers, UTF-8 paths, known CRC32, and valid directory offsets", async () => {
  const name = "点位/front.txt",
    bytes = new TextEncoder().encode("123456789");
  const zip = new Uint8Array(await zipStore([{ name, bytes }]).arrayBuffer());
  const view = new DataView(zip.buffer);
  const nameLength = new TextEncoder().encode(name).length;
  const central = 30 + nameLength + bytes.length;
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.equal(new TextDecoder().decode(zip.slice(30, 30 + nameLength)), name);
  assert.equal(
    new TextDecoder().decode(zip.slice(30 + nameLength, central)),
    "123456789",
  );
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint32(central + 16, true), 0xcbf43926);
  assert.equal(view.getUint32(central + 42, true), 0);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 1);
  assert.equal(view.getUint32(zip.length - 6, true), central);
});
