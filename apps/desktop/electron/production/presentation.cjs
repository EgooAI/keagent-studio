const domain = require("../panorama/domain.cjs");
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
function shortCaptions(captions) {
  const splitter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return captions.flatMap((caption) => {
    const total = Array.from(caption.text).length;
    const limit = Math.ceil(total / Math.ceil(total / 12));
    const chunks = [];
    let current = "";
    for (const { segment: word } of splitter.segment(caption.text)) {
      if (!current && chunks.length && /^[\p{P}\s]+$/u.test(word)) {
        chunks[chunks.length - 1] += word;
        continue;
      }
      if (current && Array.from(current + word).length > limit) {
        chunks.push(current);
        current = "";
      }
      for (const char of word) {
        current += char;
        if (Array.from(current).length === limit) {
          chunks.push(current);
          current = "";
        }
      }
    }
    if (current) chunks.push(current);
    let used = 0;
    // shortcut: distribute each measured sentence by character count until TTS supplies word timestamps.
    return chunks.map((text) => {
      const start =
        caption.start + ((caption.end - caption.start) * used) / total;
      used += Array.from(text).length;
      return {
        ...caption,
        text,
        start,
        end:
          used === total
            ? caption.end
            : caption.start + ((caption.end - caption.start) * used) / total,
      };
    });
  });
}
function decorate(ass, segment, width, height, theme = {}) {
  if (theme.design === "short-tour") {
    const scale = Math.min(width, height) / 720;
    const captionSize = Math.round(
      34 * scale * (theme.subtitleSize === "large" ? 1.15 : 1),
    );
    const outline = Math.max(2, Math.round(3 * scale));
    ass = ass.replace(
      /^Style: Caption,.*$/m,
      `Style: Caption,Microsoft YaHei,${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,40,40,${Math.round(height * 0.28)},1`,
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
    const styles = `Style: Hook,Microsoft YaHei,${titleSize},&H00${color},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.round(4 * scale)},0,8,35,35,0,1\nStyle: Facts,Microsoft YaHei,${Math.round(34 * scale)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,8,35,35,0,1\n`;
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
    /Style: Caption,Microsoft YaHei,\d+/,
    `Style: Caption,Microsoft YaHei,${size}`,
  );
  if (!theme.title) return ass;
  const titleLines = lines(theme.title, width < height ? 12 : 28);
  const titleSize = Math.round(width / (width < height ? 11 : 22));
  const top = Math.round(height * 0.2);
  const left = Math.round(width * 0.07);
  const color = theme.brandColor.slice(1).match(/../g).reverse().join("");
  const styles = `Style: Accent,Microsoft YaHei,10,&H00${color},&H00FFFFFF,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\nStyle: Title,Microsoft YaHei,${titleSize},&H00FFFFFF,&H00FFFFFF,&H50303030,&H80000000,-1,0,0,0,100,100,0,0,1,1,1,7,${left},${left},${top},1\nStyle: Facts,Microsoft YaHei,${Math.round(titleSize * 0.55)},&H00FFFFFF,&H00FFFFFF,&H50303030,&H80000000,0,0,0,0,100,100,0,0,1,1,1,7,${left},${left},${top + titleLines.length * (titleSize + 8) + 18},1\n`;
  ass = ass.replace("[Events]", styles + "\n[Events]");
  const events = `Dialogue: 1,0:00:00.00,0:10:00.00,Accent,,0,0,0,,{\\an7\\pos(${left},${top - 18})\\p1}m 0 0 l ${Math.round(width * 0.1)} 0 l ${Math.round(width * 0.1)} 6 l 0 6{\\p0}\nDialogue: 1,0:00:00.00,0:10:00.00,Title,,0,0,0,,${titleLines.join("\\N")}\n${theme.facts ? `Dialogue: 1,0:00:00.00,0:10:00.00,Facts,,0,0,0,,${lines(theme.facts, width < height ? 22 : 48, 3).join("\\N")}\n` : ""}`;
  return ass + events;
}
module.exports = { card, decorate, shortCaptions };
