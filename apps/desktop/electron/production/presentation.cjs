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
function decorate(ass, segment, width, height, theme = {}) {
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
module.exports = { card, decorate };
