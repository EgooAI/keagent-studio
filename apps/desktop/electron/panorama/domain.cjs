const { createHash } = require("node:crypto");

const templates = [
  {
    id: "tour",
    version: "1",
    name: "逐空间带看",
    opening: "今天带您看看{title}。{facts}",
    scene: "来到{room}。{description}",
    closing: "想了解这套房子的更多情况，欢迎联系经纪人。",
  },
  {
    id: "highlights",
    version: "1",
    name: "卖点先行",
    opening: "这套{title}，值得关注的是：{sellingPoints}。{facts}",
    scene: "接下来看看{room}。{description}",
    closing: "具体房屋情况，请以实地看房和核验资料为准。",
  },
  {
    id: "concise",
    version: "1",
    name: "简洁介绍",
    opening: "{title}。{facts}",
    scene: "{room}。{description}",
    closing: "欢迎预约实地看房。",
  },
];
const defaultConfig = {
  templateId: "tour",
  language: "zh-CN",
  scriptProvider: "template",
  openingTemplate: templates[0].opening,
  sceneTemplate: templates[0].scene,
  closingTemplate: templates[0].closing,
  videoMode: "voiceover",
  ttsProvider: "system",
  voice: "",
  rate: 1,
  avatarId: "",
  speed: 4,
  direction: 1,
  maxSweep: 100,
  aspectRatio: "9:16",
  resolution: "720p",
  subtitles: true,
};
const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
function text(value, label, max = 1000) {
  ensure(
    typeof value === "string" && value.trim() && value.length <= max,
    `${label}不能为空，且不能超过 ${max} 字`,
  );
  ensure(
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),
    `${label}包含无效字符`,
  );
  return value.trim();
}
function config(input) {
  ensure(input && typeof input === "object", "缺少制作配置");
  const c = Object.fromEntries(
    Object.keys(defaultConfig).map((key) => [
      key,
      input[key] ?? defaultConfig[key],
    ]),
  );
  ensure(
    templates.some((t) => t.id === c.templateId),
    "文案模板不存在",
  );
  ensure(["zh-CN", "en-US"].includes(c.language), "请选择支持的语言");
  ensure(["template", "ai"].includes(c.scriptProvider), "文案生成方式无效");
  ensure(["system", "volcengine"].includes(c.ttsProvider), "配音服务无效");
  ensure(["voiceover", "avatar"].includes(c.videoMode), "视频模板无效");
  for (const key of ["openingTemplate", "sceneTemplate", "closingTemplate"])
    c[key] = text(c[key], "文案模板", 1500);
  ensure(typeof c.voice === "string" && c.voice.length <= 150, "声音无效");
  ensure(
    typeof c.avatarId === "string" && /^[a-zA-Z0-9_-]{0,150}$/.test(c.avatarId),
    "数字人形象 ID 无效",
  );
  for (const [key, min, max] of [
    ["rate", 0.5, 2],
    ["speed", 0.5, 12],
    ["maxSweep", 1, 180],
  ])
    ensure(
      typeof c[key] === "number" &&
        Number.isFinite(c[key]) &&
        c[key] >= min &&
        c[key] <= max,
      `${key} 超出范围`,
    );
  ensure([1, -1].includes(c.direction), "旋转方向无效");
  ensure(
    ["9:16", "16:9"].includes(c.aspectRatio) &&
      ["720p", "1080p"].includes(c.resolution),
    "输出规格无效",
  );
  ensure(typeof c.subtitles === "boolean", "字幕开关无效");
  return c;
}
function fill(template, values) {
  return template.replace(/\{([^{}]+)\}/g, (_, key) => {
    ensure(Object.hasOwn(values, key), `未知模板变量：${key}`);
    return values[key];
  });
}
function segments(property, scenes, c) {
  ensure(scenes.length > 0 && scenes.length <= 20, "请导入 1–20 张全景图");
  const en = c.language === "en-US";
  const facts = [
    property.areaSqm > 0
      ? en
        ? `${property.areaSqm} square metres`
        : `面积${property.areaSqm}平方米`
      : "",
    property.layout,
    property.priceCents > 0
      ? en
        ? `CNY ${property.priceCents / 100}`
        : `总价${property.priceCents / 1000000}万元`
      : "",
  ]
    .filter(Boolean)
    .join(en ? ", " : "，");
  const values = {
    title: text(property.title, "房源名称", 200),
    facts,
    sellingPoints:
      (property.sellingPoints || []).join(en ? ", " : "，") ||
      (en ? "please review the room details" : "各空间的实际情况"),
    room: "",
    description: "",
  };
  return [
    {
      id: "opening",
      kind: "opening",
      sceneId: scenes[0].id,
      text: fill(c.openingTemplate, values),
    },
    ...scenes.map((scene) => ({
      id: scene.id,
      kind: "scene",
      sceneId: scene.id,
      text: fill(c.sceneTemplate, {
        ...values,
        room: text(scene.room, "空间名称", 80),
        description: text(scene.description, "空间说明", 1500),
      }),
    })),
    {
      id: "closing",
      kind: "closing",
      sceneId: scenes.at(-1).id,
      text: fill(c.closingTemplate, values),
    },
  ];
}
function validateSegments(input, expected) {
  ensure(
    Array.isArray(input) && input.length === expected.length,
    "文案段落数量已变化，请重新生成",
  );
  return expected.map((s, i) => {
    ensure(input[i].id === s.id, "文案与空间不匹配");
    return { ...s, text: text(input[i].text, "分段文案", 2000) };
  });
}
function sentences(value) {
  // Bound subtitle length without estimating speech duration; every chunk gets its own audio.
  const sentenceSplitter = new Intl.Segmenter("zh-CN", {
    granularity: "sentence",
  });
  const wordSplitter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return [...sentenceSplitter.segment(value)].flatMap(({ segment }) => {
    const chunks = [];
    let current = "";
    for (const { segment: word } of wordSplitter.segment(segment.trim())) {
      if (current && Array.from(current + word).length > 32) {
        chunks.push(current.trim());
        current = "";
      }
      current += word;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  });
}
function motion(start, duration, c) {
  ensure(
    Number.isFinite(start) && Number.isFinite(duration) && duration > 0,
    "镜头参数无效",
  );
  const sweep = Math.min(duration * c.speed, c.maxSweep) * c.direction;
  return { start, end: start + sweep, sweep, duration };
}
function audioKey(segment, c) {
  return hash([
    "tts-v2",
    segment.text,
    c.ttsProvider,
    c.voice,
    c.language,
    c.rate,
  ]);
}
module.exports = {
  templates,
  defaultConfig,
  config,
  ensure,
  text,
  hash,
  fill,
  segments,
  validateSegments,
  sentences,
  motion,
  audioKey,
};
