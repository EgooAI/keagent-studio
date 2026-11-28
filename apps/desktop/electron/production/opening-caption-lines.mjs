const words = new Intl.Segmenter("zh-CN", { granularity: "word" });

export function openingCaptionText(text) {
  // Decimal points and percent signs carry numeric meaning in listing details.
  return text
    .replace(
      /(?<=\p{Nd})([.．](?=\p{Nd})|[%％])|\p{P}/gu,
      (_, numeric) => numeric ?? "",
    )
    .trim();
}

// Count wide glyphs as one cell and narrow Latin characters as half a cell.
function width(text) {
  let cells = 0;
  for (const ch of text) cells += ch.codePointAt(0) < 128 ? 0.5 : 1;
  return cells;
}
// Boundaries are offsets in the original transcript, including its punctuation.
function breaks(text) {
  const ranks = new Map();
  const tokens = Array.from(words.segment(text)).filter(
    (part) => part.isWordLike,
  );
  for (let i = 1; i < tokens.length; i++) {
    const { index, segment: right } = tokens[i];
    const left = tokens[i - 1].segment;
    let rank = 0;
    if (
      /^(的|地|得|了|着|过|旁|边|里|内|外|上|下|附近|旁边|之中|之间)$/.test(
        right,
      )
    )
      rank += 24;
    if (/^(在|从|往|向|把|被|给|离|距|到|和|与|及|一|这|那)$/.test(left))
      rank += 18;
    if (
      /^(就|就可以|然后|但是|如果|接着|所以|因为|再|最后|我们|大家)$/.test(
        right,
      )
    )
      rank -= 4;
    if (
      /[，、；：。！？,;:!?]/u.test(
        text.slice(tokens[i - 1].index + left.length, index),
      )
    )
      rank -= 14;
    ranks.set(index, rank);
  }
  // Keep quantities and short prepositional phrases intact, including unfamiliar names.
  const spans =
    /\d+(?:[.．]\d+)*(?:[%％]|[百千万亿]?(?:平方(?:千米|米)|平米|公里|公斤|分钟|小时|厘米|千克|毫升|美元|元|米|克|度|秒|岁|个|倍)|[百千万亿])?|(?:在|从|距|离|往|向)[\p{Script=Han}]{1,10}?(?:旁边|附近|里面|外面|之间|之中|旁|内|外)/gu;
  for (const match of text.matchAll(spans)) {
    for (let j = match.index + 1; j < match.index + match[0].length; j++)
      ranks.set(j, 38);
  }
  return ranks;
}

const portraitLineWidth = 14;
export function openingCaptionLines(text, aspect = 9 / 16) {
  text = openingCaptionText(text);
  const limit = portraitLineWidth * Math.max(1, aspect);
  if (width(text) <= limit * 0.87 || text.includes("\n")) return text;
  let best = -1,
    score = Infinity;
  const ranks = breaks(text);
  let leftWidth = 0,
    index = 0;
  const total = width(text);
  for (const ch of text) {
    if (index) {
      const rightWidth = total - leftWidth;
      const overflow = Math.max(0, leftWidth - limit, rightWidth - limit);
      const cost =
        overflow * 80 +
        Math.abs(leftWidth - rightWidth) +
        (ranks.get(index) ?? 48);
      if (cost < score) {
        best = index;
        score = cost;
      }
    }
    index += ch.length;
    leftWidth += width(ch);
  }
  return best < 0
    ? text
    : text.slice(0, best).trimEnd() + "\n" + text.slice(best).trimStart();
}

export function openingCaptionPages(phrases, duration) {
  if (!Array.isArray(phrases) || !phrases.every(Array.isArray))
    throw new Error("开场识别缺少逐词时间");
  const timed = phrases.flat();
  let previous = 0;
  for (const word of timed) {
    if (
      !word ||
      typeof word.text !== "string" ||
      !word.text.trim() ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < previous ||
      word.end <= word.start ||
      word.end > duration + 0.001
    )
      throw new Error("开场字幕逐词时间无效");
    previous = word.end;
  }
  const pages = [];
  let start = 0;
  for (let i = 1; i <= timed.length; i++) {
    if (
      i < timed.length &&
      timed[i].start - timed[i - 1].end < 0.35 - 1e-6 &&
      (!/[。！？!?；;.]$/u.test(timed[i - 1].text) ||
        (timed[i - 1].text.endsWith(".") && /^\d/.test(timed[i].text)))
    )
      continue;
    pages.push(...planPages(timed.slice(start, i)));
    start = i;
  }
  return pages;
}

function planPages(timed) {
  const n = timed.length;
  const raw = timed.map((w) => w.text).join("");
  const ranks = breaks(raw);
  const offsets = [0],
    widths = [0];
  for (const word of timed) {
    offsets.push(offsets.at(-1) + word.text.length);
    widths.push(widths.at(-1) + width(word.text));
  }
  const costs = Array(n + 1).fill(Infinity),
    next = Array(n);
  costs[n] = 0;
  // Optimize the whole passage so the last few words do not get stranded.
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j <= n; j++) {
      const size = widths[j] - widths[i];
      if (j > i + 1 && size > portraitLineWidth * 2) break;
      const seconds = timed[j - 1].end - timed[i].start;
      let cost =
        13 +
        Math.max(0, size - 19) ** 2 * 0.42 +
        Math.max(0, 5 - size) ** 2 +
        Math.max(0, 0.85 - seconds) * 19 +
        Math.max(0, seconds - 4.5) ** 2 * 2;
      if (j < n) {
        const leading = timed[j].text.match(/^\s*/u)[0].length;
        cost +=
          (ranks.get(offsets[j] + leading) ?? 48) -
          Math.min(0.34, timed[j].start - timed[j - 1].end) * 45;
      }
      if (cost + costs[j] < costs[i]) {
        costs[i] = cost + costs[j];
        next[i] = j;
      }
    }
  }
  const pages = [];
  for (let i = 0; i < n; i = next[i]) {
    const j = next[i];
    const text = openingCaptionText(raw.slice(offsets[i], offsets[j]));
    if (text)
      pages.push({ text, start: timed[i].start, end: timed[j - 1].end });
  }
  return pages;
}
