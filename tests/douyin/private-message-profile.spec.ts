import { expect, test, type Page } from "@playwright/test";
import { conversation } from "../../apps/desktop/electron/social/message-conversation";

const profile = "https://www.douyin.com/user/MS4w-test-peer";
const text = "仅供本地验证";

async function fixture(page: Page, html: string) {
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(profile);
  return (
    action: Parameters<typeof conversation>[0],
    submittedAt = 0,
    body = text,
  ) =>
    page.evaluate<ReturnType<typeof conversation>>(
      "(" +
        conversation.toString() +
        ")(" +
        [action, profile, body, 0, false, submittedAt]
          .map((v) => JSON.stringify(v))
          .join(",") +
        ")",
    );
}

function profilePage(content: string, onClick: string, heading = "") {
  return `<nav><button data-e2e="im-entry" id="inbox" onclick="this.dataset.clicked='yes'">私信</button></nav>
    <div id="user_detail_element" data-e2e="user-detail">${heading}<button id="entry"
    onclick="this.dataset.clicked='yes';${onClick}">私信</button></div>
    <section data-e2e="im-dialog"><div id="imSaasContainerId">${content}</div></section>`;
}

function chatPanel(id: string, heading = "", hidden = true) {
  return `<div id="${id}" class="StackLayoutpagespageRoot" ${hidden ? "hidden" : ""}>
    ${heading ? '<div class="StackLayoutStackTitleBartitleBar"><span class="StackLayoutStackChatHeadertitle">' + heading + "</span></div>" : ""}
    <div class="messageMessageListlist"></div>
    <div data-e2e="msg-input"><div class="messageEditorinputArea" contenteditable="true" data-placeholder="发送消息"></div>
      <svg class="e2e-send-msg-btn" onclick="this.dataset.clicked='yes'"></svg>
    </div></div>`;
}

for (const [label, heading, remark] of [
  [
    "主页昵称、头像与会话备注、头像不同",
    '<h1>新昵称</h1><img alt="新昵称头像" src="/new-avatar.png">',
    '看房客户备注<img alt="会话头像" src="/old-avatar.png">',
  ],
  ["主页及会话都不提供名字、头像和更多菜单", "", ""],
]) {
  test(label + "，从目标主页打开预先隐藏的抽屉后可聚焦", async ({ page }) => {
    const run = await fixture(
      page,
      profilePage(
        chatPanel("old", "旧会话", false) + chatPanel("target", remark),
        "target.hidden=false;target.style.transform=''",
        heading,
      ),
    );
    if (remark) {
      // The widget can keep an inactive page mounted outside the viewport.
      await page.locator("#target").evaluate((el: HTMLElement) => {
        el.hidden = false;
        el.style.transform = "translateX(200vw)";
      });
    }
    expect((await run("inspect")).ready).toBe(false);
    await expect(page.locator("#target")).not.toBeInViewport();
    expect((await run("open")).ready).toBe(true);
    await expect(page.locator("#entry")).toHaveAttribute("data-clicked", "yes");
    await expect(page.locator("#inbox")).not.toHaveAttribute(
      "data-clicked",
      "yes",
    );
    expect((await run("focus")).ready).toBe(true);
    await expect(page.locator("#target [contenteditable=true]")).toBeFocused();
    await expect(page.locator("#old [contenteditable=true]")).not.toBeFocused();
    await expect(page.locator("svg[data-clicked]")).toHaveCount(0);
  });
}

for (const [label, panels, onClick] of [
  ["点击后只有之前已经打开的会话", chatPanel("old", "旧会话", false), ""],
  [
    "按钮同时打开两个可输入的会话",
    chatPanel("first") + chatPanel("second"),
    "first.hidden=false;second.hidden=false",
  ],
]) {
  test(label + "，不会聚焦或发送", async ({ page }) => {
    const run = await fixture(page, profilePage(panels, onClick));
    await run("open");
    await expect(page.locator("#entry")).toHaveAttribute("data-clicked", "yes");
    expect((await run("inspect")).ready).toBe(false);
    expect((await run("focus")).ready).toBe(false);
    expect((await run("history")).ready).toBe(false);
    expect((await run("submit")).ready).toBe(false);
    await expect(page.locator("[contenteditable=true]:focus")).toHaveCount(0);
    await expect(page.locator("svg[data-clicked]")).toHaveCount(0);
  });
}

test("目标主页没有私信按钮时，不点击总收件箱或使用旧会话", async ({ page }) => {
  const run = await fixture(page, profilePage(chatPanel("old", "", false), ""));
  await page.locator("#entry").evaluate((el) => el.remove());
  expect((await run("open")).ready).toBe(false);
  expect((await run("focus")).ready).toBe(false);
  await expect(page.locator("#inbox")).not.toHaveAttribute(
    "data-clicked",
    "yes",
  );
  await expect(page.locator("svg[data-clicked]")).toHaveCount(0);
});

test("原评论指向的主页与当前网址不同时不点击私信", async ({ page }) => {
  const run = await fixture(
    page,
    profilePage(chatPanel("target"), "target.hidden=false"),
  );
  await page.evaluate(() =>
    history.replaceState(null, "", "/user/someone-else"),
  );
  expect((await run("open")).ready).toBe(false);
  await expect(page.locator("#entry")).not.toHaveAttribute(
    "data-clicked",
    "yes",
  );
  await expect(page.locator("#target")).toBeHidden();
});

test("草稿清空后不能按 Enter，历史只识别新增的相邻本人消息", async ({
  page,
}) => {
  const run = await fixture(
    page,
    profilePage(chatPanel("target"), "target.hidden=false"),
  );
  const messages = page.locator("#target .messageMessageListlist");
  const row = (index: number, body: string, mine: boolean) =>
    `<div data-index="${index}"><div class="MessageBoxTimetimeLayout">刚刚</div>
    <div data-e2e="msg-item-content"><div class="${mine ? "MessageItemTextisFromMe" : ""}"><span class="TextMessageTextpureText">${body}</span></div></div></div>`;
  await messages.evaluate(
    (el, html) => {
      el.innerHTML = html;
    },
    row(0, "上一条", false),
  );
  expect((await run("open")).ready).toBe(true);
  const before = await run("focus");
  expect(before.ready).toBe(true);
  expect(before.endRow).toBeTruthy();
  const editor = page.locator("#target [contenteditable=true]");
  await editor.fill(text + "\u200b");
  expect((await run("submit")).reason).toBe("enter");
  expect((await run("enter")).ready).toBe(true);
  await editor.fill("");
  expect((await run("enter")).ready).toBe(false);
  expect((await run("history")).draftCleared).toBe(true);
  await messages.evaluate(
    (el, html) => {
      el.insertAdjacentHTML("beforeend", html);
    },
    row(1, text, true) + row(2, "回复", false),
  );
  await editor.evaluate((el) => el.replaceWith(el.cloneNode(true)));
  expect((await run("inspect")).ready).toBe(false);
  const after = await run("history");
  expect(after.ready).toBe(true);
  expect(after.draftCleared).toBe(false);
  expect(after.previousRow).toBe(before.endRow);
  expect(after.newestOwn).toBeTruthy();
  expect(after.stackMatchCount).toBe(before.stackMatchCount + 1);
  await expect(page.locator("svg[data-clicked]")).toHaveCount(0);
});

test("陌生人会话中的首聊提示留作上一条记录，下一条本人消息才是回执", async ({
  page,
}) => {
  const notice =
    "对方回复或关注你之前，只能发送一条文字消息。请礼貌发言，自觉遵守《抖音自律公约》";
  const run = await fixture(
    page,
    profilePage(chatPanel("target"), "target.hidden=false"),
  );
  const list = page.locator("#target .messageMessageListlist");
  await list.evaluate((el, label) => {
    el.innerHTML =
      '<div data-index="0"><span class="MessageBoxTimetimeLayout">14:21</span><div class="messageMessageBoxisFullRowCenterMessage"><div class="SystemNormalSystemcontainer"></div></div></div>';
    el.querySelector(".SystemNormalSystemcontainer")!.textContent = label;
  }, notice);
  await run("open");
  const before = await run("focus");
  expect(before.ready).toBe(true);
  expect(before.stackBlank).toBe(false);
  expect(before.endRow).toBeTruthy();
  expect(await run("history", 0, notice)).toMatchObject({
    stackMatchCount: 0,
    newestOwn: "",
    firstOwn: "",
  });
  await list.evaluate((el, body) => {
    el.insertAdjacentHTML(
      "beforeend",
      '<div data-index="1"><div data-e2e="msg-item-content"><span class="MessageItemTextisFromMe"><span class="TextMessageTextpureText"></span></span></div></div>',
    );
    el.querySelector(".TextMessageTextpureText")!.textContent = body;
  }, text);
  const after = await run("history");
  expect(after.previousRow).toBe(before.endRow);
  expect(after.newestOwn).toBeTruthy();
  expect(after.stackMatchCount).toBe(1);
});

test("首次联系没有侧栏记录时，区分挂载空列表和明确空历史；禁用输入后仍从本会话读取", async ({
  page,
}) => {
  const run = await fixture(
    page,
    profilePage(
      chatPanel("old", "旧窗", false) + chatPanel("target", "目标"),
      "target.hidden=false",
    ),
  );
  await run("open");
  const list = page.locator("#target .messageMessageListlist");
  const empty = await run("focus");
  expect(empty).toMatchObject({
    stackListReady: true,
    stackBlank: true,
    stackEmpty: false,
  });
  await list.evaluate((el) => el.setAttribute("aria-busy", "true"));
  expect((await run("history")).stackBlank).toBe(false);
  await list.evaluate((el) => {
    el.removeAttribute("aria-busy");
    el.setAttribute("data-history-loaded", "true");
  });
  expect((await run("history")).stackEmpty).toBe(true);
  await page.locator("#target [contenteditable]").evaluate((el) => {
    el.setAttribute("contenteditable", "false");
    el.setAttribute("aria-disabled", "true");
  });
  expect((await run("inspect")).ready).toBe(false);
  expect((await run("history")).ready).toBe(true);
});

test("本人的首条消息只认本行时间，排除过早的相对或绝对时间和失败行", async ({
  page,
}) => {
  const run = await fixture(
    page,
    profilePage(chatPanel("target"), "target.hidden=false"),
  );
  await run("open");
  const list = page.locator("#target .messageMessageListlist");
  await list.evaluate((el, content) => {
    el.innerHTML =
      '<span class="MessageBoxTimetimeLayout">刚刚</span><div data-index="0"><div class="MessageBoxTimetimeLayout">5分钟前</div><div data-e2e="msg-item-content"><div class="MessageItemTextisFromMe"><span class="TextMessageTextpureText"></span></div></div></div>';
    el.querySelector(".TextMessageTextpureText")!.textContent = content;
  }, text);
  const now = Date.now(),
    fiveMinutesAgo = now - 330_000;
  expect((await run("history", fiveMinutesAgo)).firstOwnTimeMatches).toBe(true);
  expect((await run("receipt", fiveMinutesAgo)).receiptTexts).toEqual([text]);
  expect((await run("history", now)).firstOwn).toBe("");
  const row = list.locator("[data-index]");
  const label = row.locator(".MessageBoxTimetimeLayout");
  await label.evaluate((el) => {
    el.textContent = "刚刚";
  });
  expect((await run("receipt", now)).receiptTexts).toEqual([]);
  await label.evaluate((el, stamp) => {
    const time = new Date(stamp);
    el.textContent =
      time.getHours() + ":" + String(time.getMinutes()).padStart(2, "0");
  }, fiveMinutesAgo);
  expect((await run("receipt", fiveMinutesAgo)).receiptTexts).toEqual([text]);
  expect(
    (await run("receipt", fiveMinutesAgo - 3 * 60_000)).receiptTexts,
  ).toEqual([]);
  await row.locator(".MessageBoxTimetimeLayout").evaluate((el) => el.remove());
  const unknown = await run("history", now);
  expect(unknown.firstOwn).toBeTruthy();
  expect(unknown.firstOwnTimeMatches).toBe(false);
  await row.evaluate((el) =>
    el.setAttribute("data-timestamp", "1600000000000"),
  );
  expect((await run("history", now)).newestOwn).toBe("");
  await row.evaluate(
    (el, stamp) => el.setAttribute("data-timestamp", String(stamp)),
    now,
  );
  expect((await run("history", now)).firstOwnTimeMatches).toBe(true);
  await row.evaluate((el) => el.setAttribute("data-status", "failed"));
  expect((await run("history", now)).newestOwn).toBe("");
});
