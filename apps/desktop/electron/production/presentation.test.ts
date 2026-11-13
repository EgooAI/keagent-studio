import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const presentation = require("./presentation.cjs");
const media = require("../panorama/media.cjs");

describe("short tour presentation", () => {
  it("reflows measured sentences without losing text or crossing their audio boundaries", () => {
    const input = [
      {
        text: "这是朝南的客厅，连接阳台，窗外的视野很开阔。",
        start: 1.2,
        end: 5.6,
        file: "a.wav",
      },
      { text: "abcdefghijklmnopqrstuvwx。", start: 5.6, end: 8, file: "b.wav" },
    ];
    const output = presentation.shortCaptions(input);
    expect(output.map((v: { text: string }) => v.text).join("")).toBe(
      input.map((v) => v.text).join(""),
    );
    expect(output[0].start).toBe(1.2);
    expect(output.at(-1).end).toBe(8);
    for (const [index, caption] of output.entries()) {
      expect(caption.end).toBeGreaterThan(caption.start);
      expect(caption.text).not.toMatch(/^[\p{P}\s]+$/u);
      expect(
        Array.from(caption.text.replace(/[\p{P}\s]/gu, "")).length,
      ).toBeLessThanOrEqual(12);
      if (index) expect(caption.start).toBe(output[index - 1].end);
      const sentence = input.find((v) => v.file === caption.file)!;
      expect(caption.start).toBeGreaterThanOrEqual(sentence.start);
      expect(caption.end).toBeLessThanOrEqual(sentence.end);
    }
    expect(input[0].text).toBe("这是朝南的客厅，连接阳台，窗外的视野很开阔。");
  });

  it("uses factual opening headings and keeps the closing free of title cards", () => {
    const job = {
      config: {
        design: "short-tour",
        language: "zh-CN",
        subtitleSize: "standard",
      },
      property: {
        title: "小区里的三居室",
        community: "示例小区",
        sellingPoints: ["南北通透"],
        areaSqm: 104,
        layout: "3室2厅",
      },
    };
    const opening = presentation.card(job, "opening");
    expect(opening).toMatchObject({
      title: "示例小区",
      hook: "南北通透",
      facts: "面积104平方米，3室2厅",
    });
    const segment = {
      duration: 3,
      captions: [{ text: "一起来看这套房", start: 0, end: 3 }],
    };
    const ass = media.subtitles(
      segment,
      720,
      1280,
      "独立测试场景，非在售房源",
      0,
    );
    const decorated = presentation.decorate(ass, segment, 720, 1280, opening);
    expect(decorated).toContain("Style: Caption,Microsoft YaHei,34");
    expect(decorated).toContain(",3,0,2,40,40,358,1");
    expect(decorated).toContain("&H0047D4FF");
    expect(decorated).toContain("独立测试场景，非在售房源");
    expect(decorated).toContain("\\pos(360,166)");
    const custom = {
      ...job,
      config: { ...job.config, coverTitle: "崇文门西大街\n南北通透·低楼层" },
    };
    const customCard = presentation.card(custom, "opening");
    expect(customCard.title).toBe(custom.config.coverTitle);
    expect(customCard.hook).toBe("");
    const customASS = presentation.decorate(
      ass,
      segment,
      720,
      1280,
      customCard,
    );
    expect(customASS).toContain("\\pos(360,166)}崇文门西大街");
    expect(customASS).toContain("\\pos(360,236)}南北通透·低楼层");
    const avatar = {
      ...custom,
      config: { ...custom.config, openingPhoto: "agent-photo" },
    };
    const avatarCard = presentation.card(avatar, "opening");
    expect(avatarCard.avatarOpening).toBe(true);
    const avatarASS = presentation.decorate(
      ass,
      segment,
      720,
      1280,
      avatarCard,
    );
    expect(avatarASS).toContain("\\pos(360,51)}崇文门西大街");
    expect(avatarASS).toContain("\\pos(360,121)}南北通透·低楼层");
    expect(avatarASS).toContain("\\pos(360,203)}面积104平方米");
    expect(presentation.card(avatar, "cover").avatarOpening).toBeUndefined();
    expect(
      presentation.card(
        { ...avatar, config: { ...avatar.config, roomOpening: true } },
        "opening",
      ).avatarOpening,
    ).toBeUndefined();
    const closing = presentation.decorate(
      ass,
      segment,
      720,
      1280,
      presentation.card(job, "closing"),
    );
    expect(closing).not.toContain("Style: Hook");
    expect(closing).not.toContain("欢迎预约实地看房");
    expect(
      presentation.card(
        { ...job, config: { ...job.config, design: "classic" } },
        "opening",
      ),
    ).toEqual({});
  });
});
