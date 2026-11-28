import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import browser from "../apps/desktop/electron/beike/browser.cjs";
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
      let vrOnly = false;
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
                  houseArea: vrOnly ? undefined : "59.48m²",
                  houseTotalPrice: "480万",
                  isVr: !firstVisit,
                  vrInfo: {
                    houseCode: firstVisit || vrOnly ? "other" : id,
                    vrUrl: "https://open.realsee.com/ke/other",
                  },
                },
              },
            }) +
            "</script>";
        if (url === target && vrOnly) {
          body +=
            '<aside><a href="https://open.realsee.com/ke/recommended">VR 看房</a></aside>';
          if (!firstVisit)
            body += `<script>setTimeout(() => {
              window.__PRELOADED_STATE__.ershoufangDetail.houseInfo.vrInfo = {
                houseCode: "${id}", vrUrl: "https://open.realsee.com/ke/late"
              };
            }, 1600)</script>`;
        }
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
      vrOnly = true;
      visited.length = 0;
      const readVr = browser.runPage(page, "vr", { city: "北京", number: id });
      if (firstVisit) {
        await page.getByText("人机验证").waitFor();
        await page.getByRole("button", { name: "测试放行" }).click();
        await assert.rejects(readVr, /该房源暂无 VR/);
      } else {
        assert.equal(await readVr, "https://open.realsee.com/ke/late");
      }
      assert.deepEqual(visited, ["https://m.ke.com/", target]);
      await context.close();
    }
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("慢加载不占用 VR 等待时间，页面加载完成后最多等五秒", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "beike-vr-"));
  const number = "101140860601";
  const input = { city: "北京", number };
  const target = listingURL(input.city, number);
  const context = await launch(profile, true);
  try {
    let showTour = true;
    await context.route("https://m.ke.com/**", async (route) => {
      if (route.request().resourceType() === "image") {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return route.fulfill({ status: 204 });
      }
      const state = { ershoufangDetail: { houseInfo: { houseCode: number } } };
      const detail =
        "<script>window.__PRELOADED_STATE__ = " +
        JSON.stringify(state) +
        "</script>" +
        '<a href="https://open.realsee.com/ke/other">推荐房源 VR</a>' +
        '<div class="__vr_header1_container__"></div>' +
        (showTour
          ? '<img src="/slow-photo.jpg"><script>window.addEventListener("load",()=>setTimeout(()=>{const a=document.createElement("a");a.href="https://open.realsee.com/ke/mine";document.querySelector(".__vr_header1_container__").append(a)}, 1300))</script>'
          : "");
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          route.request().url() === target
            ? detail
            : '<a href="/bj/ershoufang/">北京二手房</a>',
      });
    });
    const page = context.pages()[0];
    assert.equal(
      await browser.runPage(page, "vr", input),
      "https://open.realsee.com/ke/mine",
    );
    showTour = false;
    await assert.rejects(
      browser.runPage(page, "vr", input),
      /详情页加载完成后等待 5 秒/,
    );
    const waited = await page.evaluate(
      () =>
        performance.now() -
        performance.getEntriesByType("navigation")[0].domComplete,
    );
    assert.ok(
      waited >= 4900 && waited < 6500,
      `页面加载完成后等待了 ${waited} 毫秒`,
    );
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
