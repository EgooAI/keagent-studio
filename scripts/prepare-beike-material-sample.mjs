// Public documentation example only; this does not call the authenticated AI API.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const response = JSON.parse(
  await readFile(
    path.join(
      root,
      "apps/desktop/electron/production/fixtures/beike-pic-verify.response.json",
    ),
    "utf8",
  ),
);
const directory = path.join(
  root,
  "output/property-samples/beike-official-pic-verify",
);
await mkdir(directory, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imageType = (bytes) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  throw new Error("Expected a JPEG or PNG, received a non-image response");
};
const groups = [
  [
    "data.prospect.parlor",
    "living-room",
    "客厅",
    response.data.prospect.parlor,
  ],
  ["data.prospect.toliet", "bathroom", "卫生间", response.data.prospect.toliet],
  ["data.prospect.kitchen", "kitchen", "厨房", response.data.prospect.kitchen],
  ["data.prospect.room", "bedroom", "卧室", response.data.prospect.room],
  ["data.frame", "floorplan", "户型图", response.data.frame],
  ["data.resblock.name", "community", "小区图", response.data.resblock.name],
];
const assets = [];
for (const [field, prefix, label, urls] of groups) {
  for (const [index, sourceUrl] of urls.entries()) {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.hostname !== "p.ljcdn.com")
      throw new Error(`Unexpected documentation asset host: ${url.hostname}`);
    const extension = /\.png$/i.test(url.pathname) ? ".png" : ".jpg";
    const fileName = `${prefix}-${String(index + 1).padStart(2, "0")}${extension}`;
    const destination = path.join(directory, fileName);
    let bytes = await readFile(destination).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!bytes) {
      console.log(`Downloading ${fileName}`);
      const fetched = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!fetched.ok) throw new Error(`${fileName}: HTTP ${fetched.status}`);
      bytes = Buffer.from(await fetched.arrayBuffer());
      imageType(bytes);
      await writeFile(destination, bytes);
    }
    assets.push({
      field,
      label,
      sourceUrl,
      fileName,
      mimeType: imageType(bytes),
      byteSize: bytes.length,
      sha256: sha256(bytes),
      projection: prefix === "floorplan" ? "floor-plan" : "perspective",
    });
  }
}
const manifest = {
  sample: true,
  sampleId: "beike-official-pic-verify",
  title: "贝壳官方图片验真响应示例素材",
  sourcePage: "https://open.ke.com/service/picVerify/",
  sourceEndpoint: "https://gw-open.ke.com/api/images-distinguish/distinguish",
  sourceKind: "official-documentation-example",
  aiPlatformResponseVerified: false,
  grouping:
    "URLs grouped in one official response example; listing identity not verified",
  rights:
    "贝壳公开文档示例，仅作为本地开发参考；未获得独立商业再发布授权，保留原水印。",
  listingFacts: null,
  vr: null,
  videos: [],
  assets,
};
await writeFile(
  path.join(directory, "response.example.json"),
  JSON.stringify(response, null, 2) + "\n",
);
await writeFile(
  path.join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  path.join(directory, "SOURCE.txt"),
  `${manifest.title}\n${manifest.sourcePage}\n${manifest.rights}\nNot an AI-platform success response.\n`,
);
console.log(`Prepared ${assets.length} original images in ${directory}`);
