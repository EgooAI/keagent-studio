import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const presentation = require("./presentation.cjs");
const media = require("../panorama/media.cjs");

describe("short tour presentation", () => {
  it("uses the confirmed sale reason and keeps the three cover lines separate", () => {
    const property = {
      community: "云康园小区",
      sellingPoints: ["采光好"],
      areaSqm: 227,
      layout: "5室2厅1厨3卫",
    };
    const card = presentation.card(
      {
        property,
        coverReason: "为孩子安家 卖房变现",
        templateSnapshot: { cover: { imageSource: "listing-frame" } },
      },
      "cover",
    );
    expect(card.rows).toEqual([
      "云康园小区",
      "为孩子安家 卖房变现",
      "建面227㎡，5室2厅1厨3卫",
    ]);
    expect(
      presentation.listingCoverError({ ...property, community: "" }),
    ).toContain("小区名称");
    expect(presentation.listingCoverError(property)).toBe("");
    const overlay = presentation.decorate("", null, 720, 1280, card);
    expect(overlay.match(/Dialogue:/g)).toHaveLength(3);
    expect(overlay.match(/\\1c&H00D7FF&/g)).toHaveLength(2);
    expect(overlay).toContain("\\1c&HFFFFFF&");
    expect(overlay.match(/\\3c&H000000&/g)).toHaveLength(3);
  });
  it("lets the cover pick its title, facts, layout and color separately from the movie", () => {
    const config = {
      design: "short-tour",
      brandColor: "#FFD447",
      language: "zh-CN",
      coverTitle: "审核后的片头标题",
    };
    const property = {
      title: "房源标题",
      community: "小区名",
      layout: "两室一厅",
    };
    const cover = {
      kind: "cover",
      imageSource: "last",
      titleSource: "property",
      design: "classic",
      showFacts: false,
      brandColor: "#123DEF",
    };
    const job = { config, property, templateSnapshot: { cover } };
    expect(presentation.card(job, "cover")).toMatchObject({
      title: "房源标题",
      facts: "",
      design: "classic",
      brandColor: "#123DEF",
    });
    expect(presentation.card(job, "opening")).toMatchObject({
      title: config.coverTitle,
      design: "short-tour",
      brandColor: config.brandColor,
    });
    expect(
      presentation.card(
        {
          ...job,
          templateSnapshot: {
            cover: { ...cover, titleSource: "opening", showFacts: true },
          },
        },
        "cover",
      ),
    ).toMatchObject({ title: config.coverTitle, facts: property.layout });
    expect(
      presentation.card(
        {
          ...job,
          templateSnapshot: { cover: { ...cover, imageSource: "frame" } },
        },
        "cover",
      ),
    ).toEqual({});
  });
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
      if (index) expect(caption.start).toBe(output[index - 1].end);
      const sentence = input.find((v) => v.file === caption.file)!;
      expect(caption.start).toBeGreaterThanOrEqual(sentence.start);
      expect(caption.end).toBeLessThanOrEqual(sentence.end);
    }
    expect(output.at(-1).text).toBe("abcdefghijklmnopqrstuvwx。");
    expect(input[0].text).toBe("这是朝南的客厅，连接阳台，窗外的视野很开阔。");
  });

  it("switches during the spoken comma pause and keeps the bathroom terms together", () => {
    const input = [
      { text: "卫生间也有窗，热水器和淋浴喷头都齐。", start: 0, end: 3.345458 },
    ];
    const output = presentation.shortCaptions(input, [
      { start: 0, end: 0.096667 },
      { start: 1.18875, end: 1.577333 },
      { start: 3.172125, end: 3.345458 },
    ]);
    expect(output.map((caption: { text: string }) => caption.text)).toEqual([
      "卫生间也有窗，",
      "热水器和淋浴喷头都齐。",
    ]);
    expect(output[0].end).toBeCloseTo(1.497333, 5);
    expect(output[1].start).toBe(output[0].end);
    expect(output[1].end).toBe(input[0].end);
  });

  it("preserves compound listing terms and numeric units when audio pauses are unavailable", () => {
    const text =
      "这套房面积为123.5平方米总价425 万临近公园还有洗衣机和抽油烟机。";
    const captions = presentation.shortCaptions([{ text, start: 2, end: 7 }]);
    const lines: string[] = captions.map(
      (caption: { text: string }) => caption.text,
    );
    expect(lines.join("")).toBe(text);
    for (const phrase of ["123.5平方米", "425 万", "洗衣机", "抽油烟机"])
      expect(lines.some((line) => line.includes(phrase))).toBe(true);
    expect(captions[0].start).toBe(2);
    expect(captions.at(-1).end).toBe(7);
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
    const font =
      process.platform === "darwin" ? "PingFang SC" : "Microsoft YaHei";
    expect(decorated).toContain(`Style: Caption,${font},34`);
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
