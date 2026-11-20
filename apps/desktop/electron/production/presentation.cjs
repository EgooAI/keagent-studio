const domain = require("../panorama/domain.cjs");
const subtitleFont =
  process.platform === "darwin" ? "PingFang SC" : "Microsoft YaHei";
const escape = (value) =>
  String(value || "")
    .replaceAll("\\", "＼")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝")
    .replace(/\r?\n/g, " ");
function lines(value, count, limit = 2) {
  const chars = Array.from(escape(value));
  if (chars.length > count * limit)
    chars.splice(count * limit - 1, Infinity, "…");
  const result = [];
  for (let i = 0; i < chars.length; i += count)
    result.push(chars.slice(i, i + count).join(""));
  return result;
}
function card(job, kind) {
  const cover = kind === "cover" && job.templateSnapshot?.cover;
  if (cover) {
    if (cover.imageSource === "frame") return {};
    const opening = cover.titleSource === "opening" ? card(job, "opening") : {};
    return {
      design: cover.design,
      brandColor: cover.brandColor,
      subtitleSize: job.config.subtitleSize,
      title: opening.title || job.property?.title || "",
      hook: cover.design === "short-tour" ? opening.hook : "",
      facts: cover.showFacts
        ? domain.facts(job.property || {}, job.config.language)
        : "",
    };
  }
  if (job.config.design === "short-tour") {
    const opening = kind === "opening" || kind === "cover";
    return {
      version: 1,
      design: "short-tour",
      ...(kind === "opening" &&
      !job.config.roomOpening &&
      (job.config.openingPhoto || job.config.openingClip)
        ? { avatarOpening: true }
        : {}),
      title: opening
        ? job.config.coverTitle ||
          job.property?.community ||
          job.property?.title ||
          ""
        : "",
      hook:
        opening && !job.config.coverTitle
          ? job.property?.sellingPoints?.[0] || ""
          : "",
      facts: opening
        ? domain.facts(job.property || {}, job.config.language)
        : "",
      brandColor: job.config.brandColor || "#FFD447",
      subtitleSize: job.config.subtitleSize,
    };
  }
  if (job.config.design !== "standard") return {};
  const en = job.config.language === "en-US";
  return {
    version: 2,
    title:
      kind === "closing"
        ? en
          ? "Arrange a viewing"
          : "欢迎预约实地看房"
        : kind === "opening" || kind === "cover"
          ? (kind === "cover" && job.config.coverTitle) ||
            job.property?.title ||
            ""
          : "",
    facts:
      kind === "closing"
        ? [job.config.agentName, job.config.agentContact]
            .filter(Boolean)
            .join(" · ")
        : kind === "opening" || kind === "cover"
          ? domain.facts(job.property || {}, job.config.language)
          : "",
    brandColor: job.config.brandColor || "#167D8D",
    subtitleSize: job.config.subtitleSize,
  };
}
const captionWordSplitter = new Intl.Segmenter("zh-CN", {
  granularity: "word",
});
const captionPhrase =
  /(?:\d+(?:[.,]\d+)*[ \t]*(?:平方米|平米|平方|㎡|m²|m2|万元|元|万|亿|室|厅|卫|厨|层|公里|米|分钟|[%％]))+|\d+(?:[.,]\d+)+|抽油烟机|油烟机|淋浴喷头|热水器|卫生间|洗手台|洗衣机|家属院|落地窗|推拉门|中央空调|南北通透|干湿分离|实地看房/giu;
const trailingCaptionMark = /^[\s\p{Pe}\p{Pf}，、；。！？：,;.!?:…”’"']+$/u;
const captionPauseMark = /[，、；。！？：,;.!?:…][\s\p{Pe}\p{Pf}”’"']*$/u;
const captionJoiner = /^(?:和|与|及|跟|或|的|地|得|都|把|在)\s*$/u;

function captionWords(text) {
  const words = [];
  const add = (word) => {
    if (words.length && trailingCaptionMark.test(word))
      words[words.length - 1] += word;
    else words.push(word);
  };
  let offset = 0;
  for (const match of text.matchAll(captionPhrase)) {
    for (const { segment } of captionWordSplitter.segment(
      text.slice(offset, match.index),
    ))
      add(segment);
    add(match[0]);
    offset = match.index + match[0].length;
  }
  for (const { segment } of captionWordSplitter.segment(text.slice(offset)))
    add(segment);
  return words;
}

function captionChunks(text) {
  const targetWidth = 12;
  const maxWidth = 16;
  const words = captionWords(text);
  const widths = [0];
  for (const word of words) {
    let width = widths.at(-1);
    for (const char of word) width += char.codePointAt(0) < 128 ? 0.55 : 1;
    widths.push(width);
  }
  const totalWidth = widths.at(-1);
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    if (totalWidth - widths[start] <= targetWidth) {
      chunks.push(words.slice(start).join(""));
      break;
    }
    let fitted = start;
    let preferred = start;
    let natural = start;
    for (let end = start + 1; end <= words.length; end++) {
      const width = widths[end] - widths[start];
      if (width > maxWidth) break;
      fitted = end;
      if (width <= targetWidth && !captionJoiner.test(words[end - 1]))
        preferred = end;
      if (
        width >= 4 &&
        totalWidth - widths[end] >= 4 &&
        captionPauseMark.test(words[end - 1])
      )
        natural = end;
    }
    // Preserve longer words and identifiers as a whole when there is no safe cut.
    const end =
      natural > start
        ? natural
        : fitted === words.length || totalWidth - widths[preferred] < 4
          ? fitted
          : Math.max(preferred, start + 1);
    chunks.push(words.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

function shortCaptions(captions, pauses = []) {
  return captions.flatMap((caption) => {
    const chunks = captionChunks(caption.text);
    if (chunks.length < 2) return [caption];
    const weights = chunks.map((text) =>
      Math.max(1, Array.from(text.replace(/[\s\p{P}]/gu, "")).length),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const duration = caption.end - caption.start;
    let used = 0;
    const boundaries = [
      caption.start,
      ...weights.slice(0, -1).map((weight) => {
        used += weight;
        return caption.start + (duration * used) / total;
      }),
      caption.end,
    ];
    const times = [...boundaries];
    for (let i = 1; i < boundaries.length - 1; i++) {
      if (!captionPauseMark.test(chunks[i - 1])) continue;
      const estimate = boundaries[i];
      const earliest = (boundaries[i - 1] + estimate) / 2;
      const latest = (estimate + boundaries[i + 1]) / 2;
      let bestDistance = Math.min(0.6, duration * 0.25);
      for (const { start, end } of pauses) {
        if (start <= caption.start + 0.06 || end >= caption.end - 0.06)
          continue;
        const distance = Math.abs((start + end) / 2 - estimate);
        const switchAt = Math.max(start, end - 0.08);
        if (
          distance < bestDistance &&
          switchAt > earliest &&
          switchAt < latest
        ) {
          bestDistance = distance;
          times[i] = switchAt;
        }
      }
    }
    return chunks.map((text, index) => ({
      ...caption,
      text,
      start: times[index],
      end: times[index + 1],
    }));
  });
}
function decorate(ass, segment, width, height, theme = {}) {
  if (theme.design === "classic" && theme.title) {
    const x = Math.round(width * 0.07);
    const right = width - x;
    const pad = Math.round(width * 0.026);
    const size = Math.round(Math.min(width, height) * 0.072);
    const titles = lines(theme.title, width < height ? 12 : 26);
    const facts = theme.facts
      ? lines(theme.facts, width < height ? 22 : 48)
      : [];
    const lineHeight = Math.round(size * 1.22);
    const bottom = Math.round(height * 0.91);
    const top =
      bottom -
      pad * 2 -
      titles.length * lineHeight -
      facts.length * Math.round(lineHeight * 0.6);
    const color = theme.brandColor.slice(1).match(/../g).reverse().join("");
    const event = (layer, value) =>
      `Dialogue: ${layer},0:00:00.00,0:10:00.00,Title,,0,0,0,,${value}\n`;
    const rect = (y, end, fill) =>
      event(
        0,
        `{\\an7\\pos(${x},${y})\\1c&H${fill}&\\p1}m 0 0 l ${right - x} 0 l ${right - x} ${end - y} l 0 ${end - y}{\\p0}`,
      );
    ass = ass.replace(
      "[Events]",
      `Style: Title,${subtitleFont},${size},&H002B2520,&H002B2520,&HFF000000,&HFF000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]`,
    );
    return (
      ass +
      rect(top, bottom, "FFFFFF") +
      rect(bottom, bottom + 4, color) +
      event(1, `{\\an7\\pos(${x + pad},${top + pad})}${titles.join("\\N")}`) +
      (facts.length
        ? event(
            1,
            `{\\an7\\b0\\fs${Math.round(size * 0.57)}\\pos(${x + pad},${top + pad + titles.length * lineHeight})}${facts.join("\\N")}`,
          )
        : "")
    );
  }
  if (theme.design === "short-tour") {
    const scale = Math.min(width, height) / 720;
    const captionSize = Math.round(
      34 * scale * (theme.subtitleSize === "large" ? 1.15 : 1),
    );
    const outline = Math.max(2, Math.round(3 * scale));
    ass = ass.replace(
      /^Style: Caption,.*$/m,
      `Style: Caption,${subtitleFont},${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,40,40,${Math.round(height * 0.28)},1`,
    );
    if (!theme.title) return ass;
    const titleLines = /\r?\n/.test(theme.title)
      ? theme.title
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, 2)
          .flatMap((line) => lines(line, width < height ? 12 : 24, 1))
      : lines(theme.title, width < height ? 12 : 24, theme.hook ? 1 : 2);
    if (theme.hook)
      titleLines.push(...lines(theme.hook, width < height ? 12 : 24, 1));
    const titleSize = Math.round(56 * scale);
    const top = Math.round(height * (theme.avatarOpening ? 0.04 : 0.13));
    const center = Math.round(width / 2);
    const factsTop =
      top +
      titleLines.length * Math.round(titleSize * 1.25) +
      Math.round(12 * scale);
    const color = theme.brandColor.slice(1).match(/../g).reverse().join("");
    const styles = `Style: Hook,${subtitleFont},${titleSize},&H00${color},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.round(4 * scale)},0,8,35,35,0,1\nStyle: Facts,${subtitleFont},${Math.round(34 * scale)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,8,35,35,0,1\n`;
    ass = ass.replace("[Events]", styles + "\n[Events]");
    return (
      ass +
      titleLines
        .map(
          (line, i) =>
            `Dialogue: 1,0:00:00.00,0:10:00.00,Hook,,0,0,0,,{\\an8\\pos(${center},${top + i * Math.round(titleSize * 1.25)})}${line}\n`,
        )
        .join("") +
      (theme.facts
        ? `Dialogue: 1,0:00:00.00,0:10:00.00,Facts,,0,0,0,,{\\an8\\pos(${center},${factsTop})}${lines(theme.facts, width < height ? 24 : 46, 2).join("\\N")}\n`
        : "")
    );
  }
  if (!theme.brandColor) return ass;
  const size = Math.round(
    (width / (width < height ? 22 : 38)) *
      (theme.subtitleSize === "large" ? 1.25 : 1),
  );
  ass = ass.replace(
    /^Style: Caption,[^,\r\n]+,\d+/m,
    `Style: Caption,${subtitleFont},${size}`,
  );
  if (!theme.title) return ass;
  const titleLines = lines(theme.title, width < height ? 12 : 28);
  const titleSize = Math.round(width / (width < height ? 11 : 22));
  const top = Math.round(height * 0.2);
  const left = Math.round(width * 0.07);
  const color = theme.brandColor.slice(1).match(/../g).reverse().join("");
  const styles = `Style: Accent,${subtitleFont},10,&H00${color},&H00FFFFFF,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\nStyle: Title,${subtitleFont},${titleSize},&H00FFFFFF,&H00FFFFFF,&H50303030,&H80000000,-1,0,0,0,100,100,0,0,1,1,1,7,${left},${left},${top},1\nStyle: Facts,${subtitleFont},${Math.round(titleSize * 0.55)},&H00FFFFFF,&H00FFFFFF,&H50303030,&H80000000,0,0,0,0,100,100,0,0,1,1,1,7,${left},${left},${top + titleLines.length * (titleSize + 8) + 18},1\n`;
  ass = ass.replace("[Events]", styles + "\n[Events]");
  const events = `Dialogue: 1,0:00:00.00,0:10:00.00,Accent,,0,0,0,,{\\an7\\pos(${left},${top - 18})\\p1}m 0 0 l ${Math.round(width * 0.1)} 0 l ${Math.round(width * 0.1)} 6 l 0 6{\\p0}\nDialogue: 1,0:00:00.00,0:10:00.00,Title,,0,0,0,,${titleLines.join("\\N")}\n${theme.facts ? `Dialogue: 1,0:00:00.00,0:10:00.00,Facts,,0,0,0,,${lines(theme.facts, width < height ? 22 : 48, 3).join("\\N")}\n` : ""}`;
  return ass + events;
}
module.exports = { card, decorate, shortCaptions, subtitleFont };
