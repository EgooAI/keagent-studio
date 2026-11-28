const path = require("node:path");
const cities = require("./cities.json");
const spatial = require("../production/spatial-source.cjs");
const { setTimeout: delay } = require("node:timers/promises");

const home = "https://m.ke.com/";
const account = home + "my/index";
const cityPaths = new Set(Object.values(cities));

function listingURL(city, number) {
  const slug =
    typeof city === "string" && cities[city.trim().replace(/市$/, "")];
  if (
    typeof slug !== "string" ||
    typeof number !== "string" ||
    !/^\d{1,32}$/.test(number)
  )
    throw new Error("请核对贝壳城市和房源号");
  return home + slug + "/ershoufang/" + number + ".html";
}

async function launch(resources, profile, headless = false) {
  const { chromium } = require(
    path.join(
      resources,
      "channels-runtime",
      "_internal",
      "playwright",
      "driver",
      "package",
    ),
  );
  const binary =
    process.platform === "win32"
      ? "chrome.exe"
      : "Chromium.app/Contents/MacOS/Chromium";
  return chromium.launchPersistentContext(profile, {
    executablePath: path.join(resources, "channels-browser", binary),
    headless,
    chromiumSandbox: true,
    viewport: null,
  });
}

function readListing(target) {
  if (location.origin + location.pathname !== target) return null;
  const number = target.match(/(\d+)\.html$/)[1];
  const prefix = /^window\.__PRELOADED_STATE__\s*=\s*/;
  for (const script of document.scripts) {
    const source = script.textContent.trim();
    if (!prefix.test(source)) continue;
    const detail = JSON.parse(
      source.replace(prefix, "").replace(/;\s*$/, ""),
    ).ershoufangDetail;
    const house = detail?.houseInfo;
    if (!house) continue;
    if (String(house.houseCode) !== number)
      throw new Error("详情页房源编号与输入不一致");
    const price = /^([\d,]+(?:\.\d+)?)万(?:元)?$/.exec(house.houseTotalPrice);
    const area = /^(\d+(?:\.\d+)?)\s*(?:㎡|平米|平方米|m²)$/i.exec(
      house.houseArea,
    );
    if (!price || !area || !house.houseTitle)
      throw new Error("房源主要字段缺失或格式已改变");
    const text = (value) =>
      typeof value === "string" &&
      !/^(?:暂无数据|未知|暂无|--|-)$/.test(value.trim())
        ? value.trim()
        : "";
    const more = house.more_info;
    const basic = more?.basic_property?.list ?? [];
    const register = more?.register_info?.list ?? [];
    const field = (name) =>
      text(basic.find((item) => item.name === name)?.value) ||
      text(register.find((item) => item.name === name)?.value);
    const transaction = [
      "交易权属",
      "产权年限",
      "房屋年限",
      "产权所属",
      "抵押信息",
      "房屋用途",
      "用水类型",
      "用电类型",
      "燃气",
      "有无燃气",
      "供暖方式",
    ]
      .flatMap((label) => {
        const value = field(label);
        return value ? [label + "：" + value] : [];
      })
      .join("，");
    const description = text(
      detail.houseFeature?.house_feature?.find(
        (item) => item.type === "sellPoint",
      )?.desc,
    );
    const points = (house.tags ?? [])
      .map((tag) => text(tag.title))
      .filter(Boolean);
    const explicitStatus =
      field("挂牌状态") || field("房源状态") || text(house.status);
    return {
      id: number,
      cityShort: detail.cityShort,
      listingUrl: target,
      title: house.houseTitle,
      community: house.resblockName,
      district: text(house.districtName),
      orientation: text(house.orientation),
      floor: text(house.floorStr) || text(house.floor),
      builtYear: text(house.buildingFinishYear),
      status: ["在售", "已下架", "已成交"].includes(explicitStatus)
        ? explicitStatus
        : undefined,
      elevator:
        house.elevator === "有电梯"
          ? "有"
          : house.elevator === "无电梯"
            ? "无"
            : undefined,
      description,
      transaction,
      sellingPoints: [...new Set(points)],
      totalPriceWan: Number(price[1].replaceAll(",", "")),
      layout: field("房源户型") || text(house.frameType),
      areaSqm: Number(area[1]),
      vrUrl:
        house.vrInfo &&
        (!house.vrInfo.houseCode || String(house.vrInfo.houseCode) === number)
          ? house.vrInfo.vrUrl
          : undefined,
    };
  }
  return null;
}

async function visit(page, url, referer) {
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      referer,
    });
    if (
      response &&
      response.status() >= 400 &&
      new URL(response.url()).hostname === "m.ke.com"
    )
      throw new Error("HTTP " + response.status());
  } catch (error) {
    if (page.isClosed()) throw new Error("贝壳浏览器窗口已关闭");
    if (/net::ERR_ABORTED/.test(error.message)) return;
    throw new Error("贝壳页面打开失败，请检查网络、城市和房源号后重试");
  }
}

async function runPage(page, action, input = {}) {
  const target =
    action === "detail" ? listingURL(input.city, input.number) : account;
  await visit(page, home);
  let reachedHome = false;
  let previous = "";
  let stableSince = Date.now();
  let recoverHome = false;
  let loginClicked = false;
  while (!page.isClosed()) {
    const url = new URL(page.url());
    const current = url.origin + url.pathname;
    const slug = url.pathname.split("/")[1];
    const sameListing =
      action === "detail" &&
      url.origin + "/" === home &&
      cityPaths.has(slug) &&
      url.pathname === `/${slug}/ershoufang/${input.number}.html`;
    const atHome =
      url.origin + "/" === home &&
      (url.pathname === "/" ||
        cityPaths.has(url.pathname.replace(/^\/|\/$/g, "")));
    if (current !== previous) {
      stableSince = Date.now();
      previous = current;
    }
    const challenge =
      url.hostname === "hip.ke.com" ||
      (await page
        .getByText(/^(?:人机验证|点击按钮开始验证)$/)
        .filter({ visible: true })
        .count()) ||
      (await page.locator('iframe[src*="hip.ke.com/captcha"]:visible').count());
    const signingIn =
      url.hostname === "passport.ke.com" ||
      (url.hostname.endsWith(".ke.com") &&
        (/\/(?:login|passport)(?:\/|$)/i.test(url.pathname) ||
          (await page
            .getByPlaceholder("请输入手机号", { exact: true })
            .isVisible())));
    if (challenge || signingIn) {
      if (signingIn) loginClicked = false;
      if (signingIn && !challenge && action === "check")
        return { loggedIn: false };
      recoverHome = true;
      stableSince = Date.now();
    } else if (
      atHome &&
      (!reachedHome || recoverHome) &&
      (await page
        .getByRole("link", { name: /二手房/ })
        .first()
        .isVisible())
    ) {
      reachedHome = true;
      recoverHome = false;
      await visit(page, target, page.url());
      stableSince = Date.now();
    } else if (reachedHome && (current === target || sameListing)) {
      if (action === "detail") {
        const listing = await page
          .evaluate(readListing, current)
          .catch((error) => {
            if (!/Execution context was destroyed/.test(error.message))
              throw error;
          });
        if (listing) {
          if (listing.vrUrl) {
            try {
              listing.vrUrl = spatial.sourceURL(listing.vrUrl).href;
            } catch {
              delete listing.vrUrl;
            }
          }
          const { cityShort, ...house } = listing;
          const city =
            Object.keys(cities).find((name) => cities[name] === cityShort) ??
            Object.keys(cities).find((name) => cities[name] === slug);
          if (!city) throw new Error("无法从贝壳页面确认房源城市");
          house.listingUrl = listingURL(city, house.id);
          return { city, returned: 1, houses: [house] };
        }
      } else {
        if (await page.locator("a.logout").isVisible())
          return { loggedIn: true };
        const login = page.getByRole("link", { name: "登录", exact: true });
        if (await login.isVisible()) {
          if (action === "check") return { loggedIn: false };
          if (!loginClicked) {
            loginClicked = true;
            await login.click();
          }
        }
      }
    }
    if (Date.now() - stableSince > 20000)
      throw new Error(
        action === "detail"
          ? "未能读取目标房源，请核对城市、房源号和在售状态后重试"
          : "未能确认贝壳登录状态，请重新检查",
      );
    await delay(500);
  }
  throw new Error("贝壳浏览器窗口已关闭");
}

function beikeBrowser(resources, userData) {
  let active;
  function stop() {
    active?.abort();
  }
  async function run(action, input, owner) {
    if (active)
      throw new Error("已有贝壳窗口正在使用，请先完成操作或关闭该窗口");
    if (action === "detail") listingURL(input?.city, input?.number);
    const operation = new AbortController();
    active = operation;
    let context;
    const close = () => {
      void context?.close().catch(() => {});
    };
    try {
      const key = require("node:crypto")
        .createHash("sha256")
        .update(owner)
        .digest("hex");
      try {
        context = await launch(resources, path.join(userData, "beike", key));
      } catch {
        throw new Error(
          "贝壳专用浏览器启动失败，请关闭正在使用该资料的窗口并检查安装包",
        );
      }
      operation.signal.addEventListener("abort", close, { once: true });
      operation.signal.throwIfAborted();
      const result = await runPage(
        context.pages()[0] ?? (await context.newPage()),
        action,
        input,
      );
      operation.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (operation.signal.aborted || (context && !context.pages().length))
        throw new Error("贝壳浏览器操作已结束");
      throw error;
    } finally {
      operation.signal.removeEventListener("abort", close);
      try {
        await context?.close();
      } finally {
        active = undefined;
      }
    }
  }
  return {
    run,
    stop,
    get busy() {
      return !!active;
    },
  };
}
module.exports = { beikeBrowser, launch, listingURL, runPage };
