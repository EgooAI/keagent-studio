import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, listingURL, probe } from "./probe-beike-listing.mjs";

test("每次先进入首页，等待人工验证，复用登录后仍先进入首页", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "beike-flow-"));
  const id = "101141001564";
  const target = listingURL("北京", id);
  let context;
  try {
    for (const firstVisit of [true, false]) {
      context = await launch(profile, true);
      const visited = [];
      await context.route("https://m.ke.com/**", async (route) => {
        const url = route.request().url();
        if (!route.request().isNavigationRequest()) return route.abort();
        visited.push(url);
        let body = '<a href="/bj/ershoufang/">北京二手房</a>';
        if (url === "https://m.ke.com/" && firstVisit)
          body +=
            "<p>人机验证</p><button onclick=\"document.querySelector('p').remove()\">测试放行</button>";
        if (url === target)
          body =
            "<script>window.__PRELOADED_STATE__ = " +
            JSON.stringify({
              ershoufangDetail: {
                cityShort: "km",
                houseFeature: {
                  house_feature: [
                    {
                      type: firstVisit ? "sellPoint" : "other",
                      typeName: "核心卖点",
                      desc: "小区内有泳池。",
                    },
                  ],
                },
                houseInfo: {
                  tags: [{ title: "满五年" }, { title: "精装修" }],
                  status: 1,
                  validStatus: 1,
                  is_remove: 0,
                  frameType: "3室2厅",
                  elevator: "有电梯",
                  houseUnitPrice: "8,387元/平",
                  more_info: {
                    basic_property: {
                      list: [
                        { name: "房源户型", value: "3室2厅2卫" },
                        { name: "供暖方式", value: "暂无数据" },
                      ],
                    },
                    register_info: {
                      list: [{ name: "抵押信息", value: "无抵押" }],
                    },
                  },
                  frame_info_card: {
                    list: [
                      {
                        title: "当前格局",
                        cell_info: [
                          {
                            name: "厨房",
                            area: 5.59,
                            orientation: "北",
                            window: "落地窗",
                          },
                        ],
                      },
                    ],
                  },
                  house_picture: [
                    { url: "https://ke-image.ljcdn.com/a.jpg" },
                    { url: "https://untrusted.invalid/b.jpg" },
                  ],
                  houseCode: id,
                  houseTitle: "测试房源",
                  houseArea: "59.48m²",
                  houseTotalPrice: "480万",
                  vrInfo: {
                    houseCode: firstVisit ? "other" : id,
                    vrUrl: "https://open.realsee.com/ke/other",
                  },
                },
              },
            }) +
            "</script>";
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const page = context.pages()[0];
      const reading = probe(page, "北京", id);
      if (firstVisit) {
        await page.getByText("人机验证").waitFor();
        await page.waitForTimeout(750);
        assert.deepEqual(visited, ["https://m.ke.com/"]);
        await context.addCookies([
          {
            url: "https://m.ke.com",
            name: "test-session",
            value: "ok",
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
        ]);
        await page.getByRole("button", { name: "测试放行" }).click();
      } else {
        assert.ok(
          (await context.cookies("https://m.ke.com")).some(
            (c) => c.name === "test-session",
          ),
        );
      }
      const result = await reading;
      assert.deepEqual(visited, ["https://m.ke.com/", target]);
      assert.equal(result.areaSqm, 59.48);
      assert.equal(result.totalPriceWan, 480);
      assert.equal(
        result.vrUrl,
        firstVisit ? undefined : "https://open.realsee.com/ke/other",
      );
      assert.equal(result.layout, "3室2厅2卫");
      assert.equal(result.description, firstVisit ? "小区内有泳池。" : "");
      assert.equal(result.transaction, "抵押信息：无抵押");
      assert.equal(result.status, undefined);
      assert.equal(result.listingUrl, listingURL("昆明", id));
      assert.deepEqual(result.sellingPoints, ["满五年", "精装修"]);
      for (const key of [
        "images",
        "image",
        "sourceFacts",
        "sourceUnitPrice",
        "floorPlanUrl",
      ]) {
        assert.equal(Object.hasOwn(result, key), false, key);
      }
      await context.close();
    }
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
