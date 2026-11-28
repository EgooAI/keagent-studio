import { describe, expect, it } from "vitest";
import {
  openingCaptionLines,
  openingCaptionPages,
} from "./opening-caption-lines.mjs";

function words(text: string, step = 0.16) {
  return text
    .split("|")
    .map((text, i) => ({ text, start: i * step, end: (i + 1) * step }));
}

describe("opening transcript layout", () => {
  it.each([
    [
      "总价|只|需要|128|万|就|可以|在|北辰|财富|中心|旁|买|一套|183|平米|的|一梯|一户|大|平层",
      ["128万", "在北辰财富中心旁", "183平米"],
    ],
    [
      "大家|可以|在|松云|展览|中心|旁|集合|然后|一起|前往|明天|的|比赛|现场",
      ["在松云展览中心旁"],
    ],
    ["宽度|大约|是|12|.|5|厘米|请|提前|准备|相同|大小|的|容器", ["12.5厘米"]],
  ] as const)(
    "preserves spoken phrases and exact word timings in %s",
    (text, intact) => {
      const timed = words(text);
      // Providers may deliver an intermediate sentence boundary without a full stop.
      const cues = openingCaptionPages([timed.slice(0, 5), timed.slice(5)], 30);
      expect(cues.map((c) => c.text).join("")).toBe(text.replaceAll("|", ""));
      const lines = cues.flatMap((c) =>
        openingCaptionLines(c.text).split("\n"),
      );
      for (const phrase of intact)
        expect(lines.some((line) => line.includes(phrase))).toBe(true);
      expect(lines.every((line) => !/^([的旁]|平米)/u.test(line))).toBe(true);
      for (const cue of cues) {
        expect(timed.some((w) => w.start === cue.start)).toBe(true);
        expect(timed.some((w) => w.end === cue.end)).toBe(true);
      }
    },
  );
  it("uses the speaker's pause and preserves silence", () => {
    const first = words("等一下|我|看看");
    const second = words("好|我们|出发").map((w) => ({
      ...w,
      start: w.start + 1.6,
      end: w.end + 1.6,
    }));
    expect(openingCaptionPages([[...first, ...second]], 3)).toEqual([
      { text: "等一下我看看", start: 0, end: first.at(-1)!.end },
      { text: "好我们出发", start: 1.6, end: second.at(-1)!.end },
    ]);
    expect(
      openingCaptionPages([words("等一下|我|看看|好|我们|出发")], 3),
    ).toHaveLength(1);
  });
  it("uses punctuation internally and lays out the same cue for either canvas", () => {
    const timed = words("如果|明天|天气|好，|我们|一起|去|公园|散步");
    expect(openingCaptionPages([timed], 3).map((c) => c.text)).toEqual([
      "如果明天天气好",
      "我们一起去公园散步",
    ]);
    const sentence = "今天带大家看一套朝南的三居室";
    expect(openingCaptionLines(sentence).split("\n")).toHaveLength(2);
    expect(openingCaptionLines(sentence, 16 / 9)).toBe(sentence);
    expect(openingCaptionPages([words("先|看| A| B| 两组")], 3)[0].text).toBe(
      "先看 A B 两组",
    );
  });
  it("rejects overlapping words and out-of-range timestamps", () => {
    const timed = words("先|后");
    expect(() => openingCaptionPages([[timed[1], timed[0]]], 3)).toThrow();
    expect(() => openingCaptionPages([timed], 0.2)).toThrow();
  });
});
