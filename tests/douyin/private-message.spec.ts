import { test, expect, type Page, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  sendSocialMessage,
  verifyExistingSocialMessage,
  type MessageExecutionSteps,
  type MessageInput,
} from "../../apps/desktop/electron/social/message";
import type { OpenCliPage } from "../../apps/desktop/electron/publishing/runtime/browser/opencli-page";

type WebView = (view: {
  path: string;
  profile: string;
  id: string;
  submits: number;
  chat: (evidence?: "both" | "link") => string;
}) => string;

function profileChat(panel: string) {
  return `<main id="user_detail_element" data-e2e="user-detail">
    <button onclick="document.getElementById('panel').hidden=false">私信</button>
    </main><div id="panel" hidden>${panel}</div>`;
}

async function fixture(
  page: Page,
  platform: MessageInput["platform"],
  outcome: "saved" | "optimistic" | "wrong" | "history" | "wrong-sender",
  view?: WebView,
  deliveryLabel?: "已送达" | "发送中",
  text = "测试正文",
) {
  const id = platform === "xhs" ? "123456789012345678901234" : "recipient";
  const profile =
    platform === "xhs"
      ? "https://www.xiaohongshu.com/user/profile/" + id
      : "https://www.douyin.com/user/" + id;
  const history = outcome === "history" || outcome === "wrong-sender";
  const historyUrl =
    "https://edith.xiaohongshu.com/api/im/web/messages/history?chat_user_id=" +
    id;
  const recipient = outcome === "wrong" ? "other" : id;
  const paths: string[] = [];
  let submits = 0,
    saved = false;
  let bubble =
    '<div data-direction="out" data-message-id="server-123">测试正文</div>';
  if (history) bubble = '<div class="xhs-im-bubble__text">测试正文</div>';
  if (deliveryLabel)
    bubble = `<div data-direction="out"><span data-e2e="message-text">测试正文</span><span data-e2e="message-status">${deliveryLabel}</span></div>`;
  await page.exposeFunction("recordSubmit", () => {
    submits++;
    saved = outcome === "saved";
  });
  const chat = (evidence: "both" | "link" = "both") => `
    <section id="chat" class="chat" ${evidence === "both" ? `data-peer-id="${recipient}"` : ""}>
      <header><a href="${profile}">测试用户</a></header>
      <div id="messages" role="log" aria-busy="false">${saved ? bubble : ""}</div>
      <textarea placeholder="消息"></textarea>
      <button id="send">发送</button>
    </section>
    <script>
      send.onclick = async () => {
        await recordSubmit();
        messages.innerHTML = ${JSON.stringify(bubble)};
      };
    </script>`;
  await page.route("**/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    const html = view
      ? view({ path, profile, id, submits, chat })
      : platform === "douyin"
        ? profileChat(chat())
        : chat();
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        html +
        (history
          ? `<script>fetch(${JSON.stringify(historyUrl)})</script>`
          : ""),
    });
  });
  if (history)
    await page.route(historyUrl, (route) =>
      route.fulfill({
        headers: { "Access-Control-Allow-Origin": "*" },
        json: {
          code: 0,
          data: {
            out_message_list: submits
              ? [
                  {
                    sender_id:
                      outcome === "wrong-sender" ? "someone-else" : "self",
                    receiver_id: id,
                    id: "new-server-id",
                    created_at: Date.now(),
                    content: JSON.stringify({ content: "测试正文" }),
                  },
                ]
              : [],
          },
        },
      }),
    );
  const browser = {
    observeJsonResponses: async (
      matches: (url: URL) => boolean,
      consume: (url: URL, data: unknown) => void,
      work: () => Promise<void>,
    ) => {
      const pending: Promise<void>[] = [];
      const listener = (response: Response) => {
        const address = new URL(response.url());
        if (matches(address))
          pending.push(response.json().then((data) => consume(address, data)));
      };
      page.on("response", listener);
      try {
        await work();
      } finally {
        page.off("response", listener);
        await Promise.all(pending);
      }
    },
    getUrl: () => page.url(),
    goto: (url: string) => page.goto(url),
    inspectDocument: <T>(source: string) => page.evaluate<T>(source),
    replaceText: async (value: string) => {
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(value);
    },
    pressMessageEnter: async (
      origin: string,
      signal: AbortSignal,
      stillReadySource: string,
    ) => {
      signal.throwIfAborted();
      if (
        new URL(page.url()).origin !== origin ||
        !(await page.evaluate(stillReadySource))
      )
        return false;
      await page.keyboard.press("Enter");
      return true;
    },
  } as unknown as OpenCliPage;
  const input = {
    accountId: "a".repeat(32),
    platform,
    profileUrl: profile,
    recipientName: "测试用户",
    text,
    requestKey: randomUUID(),
  };
  return {
    browser,
    run: (
      steps?: MessageExecutionSteps,
      signal = AbortSignal.timeout(43_000),
    ) =>
      sendSocialMessage(
        browser,
        input,
        signal,
        async () => {},
        history ? "self" : undefined,
        steps,
      ),
    submits: () => submits,
    paths,
  };
}

for (const platform of ["douyin", "xhs"] as const) {
  test(platform + "：在正确会话重新加载后核实新发出消息", async ({ page }) => {
    const f = await fixture(page, platform, "saved");
    await f.run();
    expect(f.submits()).toBe(1);
  });
}
test("抖音私信按步骤等待，发送后再重开会话核对", async ({ page }) => {
  const f = await fixture(page, "douyin", "saved");
  let finishedAt = performance.now();
  const starts: { step: string; waitMs: number }[] = [];
  await f.run({
    start: (step) =>
      starts.push({ step, waitMs: performance.now() - finishedAt }),
    complete: () => {
      finishedAt = performance.now();
    },
  });
  expect(starts.map(({ step }) => step)).toEqual([
    "open_conversation",
    "fill_message",
    "trigger_send",
    "verify_conversation",
  ]);
  for (const { step, waitMs } of starts)
    expect(waitMs).toBeGreaterThanOrEqual(
      step === "verify_conversation" ? 2950 : 1950,
    );
  expect(f.submits()).toBe(1);
});

test("抖音私信在步骤间中止时不触发发送", async ({ page }) => {
  const f = await fixture(page, "douyin", "saved");
  const stop = new AbortController();
  let activeStep = "";
  await expect(
    f.run(
      {
        start: (step) => {
          activeStep = step;
        },
        complete: () => {
          if (activeStep === "fill_message") stop.abort();
        },
      },
      stop.signal,
    ),
  ).rejects.toHaveProperty("name", "AbortError");
  expect(activeStep).toBe("fill_message");
  expect(f.submits()).toBe(0);
});
test("聊天窗的乐观气泡不会被报告为发送成功", async ({ page }) => {
  const f = await fixture(page, "douyin", "optimistic");
  await expect(f.run()).rejects.toMatchObject({ code: "DM_OUTCOME_UNKNOWN" });
  expect(f.submits()).toBe(1);
});
test("对话中的收件人和小红书地址矛盾时阻止发送", async ({ page }) => {
  const f = await fixture(page, "xhs", "wrong");
  await expect(f.run()).rejects.toMatchObject({
    code: "DM_RECIPIENT_UNVERIFIED",
  });
  expect(f.submits()).toBe(0);
});

test("小红书可用服务端会话历史核实没有 DOM 消息编号的发送", async ({
  page,
}) => {
  const f = await fixture(page, "xhs", "history");
  await f.run();
  expect(f.submits()).toBe(1);
});
test("小红书会话中同文不同发送方不足以确认本次发送", async ({ page }) => {
  const f = await fixture(page, "xhs", "wrong-sender");
  await expect(f.run()).rejects.toMatchObject({ code: "DM_OUTCOME_UNKNOWN" });
  expect(f.submits()).toBe(1);
});

test("抖音在个人资料内打开私信，聊天面板外的编辑器不接收正文", async ({
  page,
}) => {
  const f = await fixture(page, "douyin", "saved", ({ path, chat }) =>
    path === "/user/recipient"
      ? `<header><button data-e2e="im-entry" onclick="location.assign('/inbox')">私信</button></header>
         <main><section data-e2e="user-info"><button onclick="document.getElementById('panel').hidden=false">私信</button></section></main>
         <aside><textarea placeholder="消息搜索"></textarea></aside>
         <div id="panel" hidden>${chat()}</div>`
      : "<main>全局收件箱</main>",
  );
  await f.run();
  expect(f.paths).not.toContain("/inbox");
  expect(f.submits()).toBe(1);
  await expect(page.locator("aside textarea")).toHaveValue("");
});

test("抖音从收件人主页进入同源聊天页，重开同一主页核对消息记录", async ({
  page,
}) => {
  const f = await fixture(page, "douyin", "saved", ({ path, chat }) =>
    path === "/user/recipient"
      ? `<main><section data-e2e="user-info"><a href="/message/thread">私信</a></section></main>`
      : chat("link"),
  );
  const inspect = f.browser.inspectDocument.bind(f.browser);
  f.browser.inspectDocument = async <T>(script: string, opening = false) => {
    const result = await inspect<T>(script, opening);
    if (opening) {
      await page.waitForURL("**/message/thread");
      throw new Error("Execution context was destroyed during navigation");
    }
    return result;
  };
  await f.run();
  expect(f.paths.filter((path) => path === "/message/thread")).toHaveLength(2);
  expect(f.submits()).toBe(1);
});

test("主页按钮跳转其他用户主页时不向那里的编辑器发消息", async ({ page }) => {
  const f = await fixture(page, "douyin", "saved", ({ path, chat }) =>
    path === "/user/recipient"
      ? '<main data-e2e="user-detail"><a href="/user/someone-else">私信</a></main>'
      : chat(),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "DM_ENTRY_MISSING" });
  expect(f.submits()).toBe(0);
  await expect(page.locator("textarea")).toHaveValue("");
});

test("抖音等待主页打开的私信面板，不切换同时出现的会话列表", async ({
  page,
}) => {
  const f = await fixture(page, "douyin", "saved", ({ path, id, chat }) =>
    path === "/user/recipient"
      ? `<main data-e2e="user-detail"><button onclick="setTimeout(() => document.querySelector('#panel').hidden = false, 500)">私信</button></main>
         <aside class="conversation-list"><button class="conversation-item" data-peer-id="${id}" onclick="location.assign('/old-thread')">测试用户</button></aside>
         <div id="panel" hidden>${chat()}</div>`
      : "<main>历史会话</main>",
  );
  await f.run();
  expect(f.paths).not.toContain("/old-thread");
  expect(f.submits()).toBe(1);
});

test("抖音主页缺少私信入口时不改点总收件箱或已有会话", async ({ page }) => {
  const f = await fixture(page, "douyin", "saved", ({ path, id, chat }) =>
    path === "/user/recipient"
      ? `<header><button data-e2e="im-entry" onclick="location.assign('/message')">私信</button></header>
         <main><section data-e2e="user-info">测试用户</section></main>
         <aside class="conversation-list"><button class="conversation-item" data-peer-id="${id}" onclick="location.assign('/message/thread')">测试用户</button></aside>`
      : chat(),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "DM_ENTRY_MISSING",
  });
  expect(f.paths).not.toContain("/message");
  expect(f.paths).not.toContain("/message/thread");
  expect(f.submits()).toBe(0);
});

test("抖音可在同源内嵌聊天页核对标题并向已聚焦的编辑器输入", async ({
  page,
}) => {
  const f = await fixture(page, "douyin", "saved", ({ path, chat }) =>
    path === "/message/panel"
      ? chat("link")
      : `<main data-e2e="user-detail"><button onclick="document.getElementById('panel').src='/message/panel'">发私信</button></main>
         <iframe id="panel" title="私信会话"></iframe>`,
  );
  await f.run();
  expect(f.paths).toContain("/message/panel");
  expect(f.submits()).toBe(1);
});

test("小红书聊天直达页不可用时从该收件人的个人主页打开私信", async ({
  page,
}) => {
  const f = await fixture(page, "xhs", "saved", ({ path, chat }) =>
    path.startsWith("/chat/")
      ? "<main>页面不存在</main>"
      : `<main><button onclick="document.getElementById('panel').hidden=false">发消息</button></main>
         <div id="panel" hidden>${chat()}</div>`,
  );
  await f.run();
  expect(f.paths).toContain("/user/profile/123456789012345678901234");
  expect(f.submits()).toBe(1);
});

test("抖音显示明确的私信限制时记录平台拒绝，未产生发送", async ({ page }) => {
  const f = await fixture(
    page,
    "douyin",
    "saved",
    () =>
      `<main data-e2e="user-detail"><button onclick="document.getElementById('notice').hidden=false">私信</button></main>
     <div id="notice" role="alert" hidden>由于对方的隐私设置，无法发送私信</div>`,
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "DM_CONTACT_RESTRICTED",
  });
  expect(f.submits()).toBe(0);
});

for (const [scenario, hint, disabled, expected] of [
  ["enterkeyhint=send", "enterkeyhint", false, 1],
  ["编辑器提示按 Enter 发送", "placeholder", false, 1],
  ["没有回车发送提示", "", false, 0],
  ["有回车提示但发送按钮禁用", "enterkeyhint", true, 0],
] as const) {
  test("无可点击的发送按钮：" + scenario, async ({ page }) => {
    const f = await fixture(
      page,
      "douyin",
      "saved",
      ({ chat }) =>
        profileChat(chat()) +
        `<script>
        const editor = document.querySelector('#chat textarea');
        const dispatch = send.onclick;
        if (${JSON.stringify(hint)} === 'enterkeyhint') editor.setAttribute('enterkeyhint', 'send');
        if (${JSON.stringify(hint)} === 'placeholder') editor.placeholder = '消息，按 Enter 发送';
        if (${disabled}) send.disabled = true; else send.remove();
        editor.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); dispatch(); }
        });
      </script>`,
    );
    if (expected) {
      await f.run();
    } else {
      await expect(f.run()).rejects.toMatchObject({
        code: "DM_NOT_DISPATCHED",
      });
      await expect(page.locator("#chat textarea")).toHaveValue("测试正文");
    }
    expect(f.submits()).toBe(expected);
  });
}

for (const [scenario, outcome, label, delivered] of [
  ["重开后仍有已送达标记", "saved", "已送达", true],
  ["已送达标记在重开后消失", "optimistic", "已送达", false],
  ["重开后仍仅显示发送中", "saved", "发送中", false],
] as const) {
  test("无 DOM 消息编号：" + scenario, async ({ page }) => {
    const f = await fixture(page, "douyin", outcome, undefined, label);
    if (delivered) await f.run();
    else
      await expect(f.run()).rejects.toMatchObject({
        code: "DM_OUTCOME_UNKNOWN",
      });
    expect(
      f.paths.filter((path) => path === "/user/recipient").length,
    ).toBeGreaterThanOrEqual(2);
    expect(f.submits()).toBe(1);
  });
}

test("发送后重新打开会话失败时记录待核实且不重复提交", async ({ page }) => {
  const f = await fixture(page, "douyin", "saved", ({ submits, chat }) =>
    submits ? "<main>会话暂不可用</main>" : profileChat(chat()),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "DM_OUTCOME_UNKNOWN" });
  expect(f.submits()).toBe(1);
});

test("个人主页已有聊天编辑器但没有主页私信入口时不发送", async ({ page }) => {
  const f = await fixture(
    page,
    "douyin",
    "saved",
    ({ profile, chat }) =>
      `<div class="chat-layout"><aside><header><a href="${profile}">目标</a></header></aside>
      <div class="chat-panel">${chat("link").replace(/<header>.*?<\/header>/, "<header>另一位用户</header>")}</div></div>`,
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "DM_ENTRY_MISSING",
  });
  expect(f.submits()).toBe(0);
  await expect(page.locator("textarea")).toHaveValue("");
});

test("主页私信按钮没有打开新窗口时，不向原有输入框写入", async ({ page }) => {
  const f = await fixture(
    page,
    "douyin",
    "saved",
    ({ chat }) =>
      `<main data-e2e="user-detail"><button>私信</button></main>${chat()}`,
  );
  await expect(f.run()).rejects.toMatchObject({ code: "DM_EDITOR_MISSING" });
  expect(f.submits()).toBe(0);
  await expect(page.locator("textarea")).toHaveValue("");
});

test("点击后才加载的旧同文记录不能核实本次发送", async ({ page }) => {
  const f = await fixture(page, "douyin", "saved", ({ chat }) =>
    profileChat(chat())
      .replace('aria-busy="false"', 'aria-busy="true"')
      .replaceAll(
        'data-direction="out"',
        'data-direction="out" data-timestamp="1600000000000"',
      ),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "DM_OUTCOME_UNKNOWN" });
  expect(f.submits()).toBe(1);
});

const messageBody = "你好";
const threadName = "评论后改过的昵称";
const greeting = `和“${threadName}”打个招呼吧`;
function stackRow(
  index: number,
  text: string,
  own: boolean,
  time = "刚刚",
  failed = false,
) {
  return `<div data-index="${index}" ${failed ? 'data-status="failed"' : ""}>
    <span class="MessageBoxTimetimeLayout">${time}</span>
    <div data-e2e="msg-item-content"><div class="${own ? "MessageItemTextisFromMe" : ""}">
    <span class="TextMessageTextpureText">${text}</span></div></div></div>`;
}
const previous = stackRow(0, "上一条", false);
const ownFirst = stackRow(0, messageBody, true);
const ownNext = stackRow(1, messageBody, true);
for (const [label, rows, accepted] of [
  [
    "从目标主页读取刚发出的一条，含旧的本人消息",
    stackRow(0, "你好", true, "25分钟前") +
      stackRow(1, "测试一下", true, "8分钟前"),
    true,
  ],
  [
    "同一时间范围内重复的同文",
    stackRow(0, "测试一下", true, "8分钟前") +
      stackRow(1, "测试一下", true, "8分钟前"),
    false,
  ],
  [
    "旧同文、收到的同文及失败的同文",
    stackRow(0, "测试一下", true, "25分钟前") +
      stackRow(1, "测试一下", false, "8分钟前") +
      stackRow(2, "测试一下", true, "8分钟前", true),
    false,
  ],
] as const) {
  test("只读核对：" + label, async ({ page }) => {
    const f = await fixture(page, "douyin", "saved", () =>
      profileChat(
        `<div class="StackLayoutpagespageRoot"><div class="messageMessageListlist">${rows}</div></div>`,
      ),
    );
    const result = await verifyExistingSocialMessage(
      f.browser,
      {
        profileUrl: "https://www.douyin.com/user/recipient",
        submittedAt: Date.now() - 8.5 * 60_000,
        matchesText: (value) => value === "测试一下",
      },
      AbortSignal.timeout(12_000),
    );
    expect(result).toBe(accepted);
    expect(f.submits()).toBe(0);
    expect(f.paths.filter((path) => path === "/user/recipient")).toHaveLength(
      1,
    );
  });
}
type StackView = {
  rows?: string;
  newestFirst?: boolean;
  preview?: string;
  busy?: boolean;
  locked?: boolean;
  minutesLater?: number;
};
type StackCase = {
  title: string;
  text?: string;
  before: StackView;
  onInput?: string;
  afterEnter?: string;
  keepDraft?: boolean;
  history: StackView[];
  success: boolean;
};
const receipts: StackCase[] = [
  {
    title: "真实的最新行编号为零，已有的本人你好从零移到一",
    text: "测试一下",
    before: { rows: stackRow(0, "你好", true, "25分钟前"), newestFirst: true },
    history: [
      {
        rows:
          stackRow(0, "测试一下", true) + stackRow(1, "你好", true, "25分钟前"),
        newestFirst: true,
        locked: true,
      },
    ],
    success: true,
  },
  {
    title: "逆序历史含一条随后收到的回复，原头部移到二",
    text: "测试一下",
    before: { rows: stackRow(0, "你好", true, "25分钟前"), newestFirst: true },
    history: [
      {
        rows:
          stackRow(0, "收到了", false) +
          stackRow(1, "测试一下", true) +
          stackRow(2, "你好", true, "25分钟前"),
        newestFirst: true,
      },
    ],
    success: true,
  },
  {
    title: "逆序列表只是往上加载了旧同文，原来的头部未移动",
    text: "测试一下",
    before: { rows: stackRow(0, "你好", true, "25分钟前"), newestFirst: true },
    history: [
      {
        rows:
          stackRow(0, "你好", true, "25分钟前") +
          stackRow(1, "测试一下", true, "") +
          stackRow(2, "你好", true, ""),
        newestFirst: true,
      },
    ],
    success: false,
  },
  {
    title: "已知末条，第一屏错过回显，重开时对方已回复",
    before: { rows: previous, preview: "上一条" },
    history: [
      {
        rows: previous + ownNext + stackRow(2, "已收到", false),
        preview: "已收到",
      },
    ],
    success: true,
  },
  {
    title: "首次联系，已知空态，预览未同步且重开后只能看历史",
    before: { preview: greeting },
    history: [{ rows: ownFirst, preview: "上一条预览", locked: true }],
    success: true,
  },
  {
    title: "无打招呼预览，发送后原草稿清空，五分钟后重开只有本人你好",
    before: {},
    afterEnter: ownFirst,
    history: [
      {
        rows: stackRow(0, messageBody, true, "5分钟前"),
        locked: true,
        minutesLater: 5,
      },
    ],
    success: true,
  },
  {
    title: "无可靠空态，只有重开时看到同文",
    before: {},
    history: [{ rows: ownFirst }],
    success: false,
  },
  {
    title: "无打招呼预览，草稿未清空，迟到的旧同文",
    before: {},
    afterEnter: ownFirst,
    keepDraft: true,
    history: [{ rows: ownFirst }],
    success: false,
  },
  {
    title: "无打招呼预览，首次回显后独立预览明确相悖",
    before: {},
    afterEnter: ownFirst,
    history: [{ rows: ownFirst, preview: "另一条私信" }],
    success: false,
  },
  {
    title: "尚在加载的空历史不能证明旧同文为本次发送",
    before: { busy: true },
    afterEnter: ownFirst,
    history: [{ rows: ownFirst }],
    success: false,
  },
  {
    title: "未加载的旧同文已经在会话预览中",
    before: { preview: messageBody },
    afterEnter: ownFirst,
    history: [{ rows: ownFirst, preview: messageBody }],
    success: false,
  },
  {
    title: "输入时才加载的旧同文",
    before: { preview: greeting },
    onInput: ownFirst,
    history: [{ rows: ownFirst }],
    success: false,
  },
  {
    title: "已知空态，首次重开仍加载中，再次只读重开核实",
    before: { preview: greeting },
    history: [{ busy: true }, { rows: ownFirst }],
    success: true,
  },
  {
    title: "乐观气泡重开后丢失",
    before: { preview: greeting },
    afterEnter: ownFirst,
    history: [{}],
    success: false,
  },
  {
    title: "重开后本人气泡带失败状态",
    before: { preview: greeting },
    afterEnter: ownFirst,
    history: [{ rows: stackRow(0, messageBody, true, "刚刚", true) }],
    success: false,
  },
  {
    title: "重开气泡时间明确早于本次发送",
    before: { preview: greeting },
    afterEnter: ownFirst,
    history: [{ rows: stackRow(0, messageBody, true, "5分钟前") }],
    success: false,
  },
];
for (const scenario of receipts) {
  test("抖音虚拟会话记录：" + scenario.title, async ({ page }) => {
    let visits = 0;
    const f = await fixture(
      page,
      "douyin",
      "saved",
      ({ path, submits }) => {
        if (path !== "/user/recipient") return "";
        const view = submits
          ? scenario.history[Math.min(visits++, scenario.history.length - 1)]
          : scenario.before;
        return `<style>.messageMessageListlist,[contenteditable]{min-height:30px} svg{width:24px;height:24px}
        ${view.newestFirst ? "#messages{display:flex;flex-direction:column-reverse}" : ""}</style>
        <script>const clockNow = Date.now.bind(Date); Date.now = () => clockNow() + ${(view.minutesLater ?? 0) * 60000}</script>
        <main data-e2e="user-detail"><button onclick="panel.hidden=false">私信</button></main>
        <div data-e2e="im-dialog"><div id="imSaasContainerId">
        <div class="StackLayoutpagespageRoot"><div class="conversationConversationListwrapper">
          ${
            view.preview === undefined
              ? ""
              : `<div class="conversationConversationItemwrapper" data-e2e="conversation-item">
            <span class="conversationConversationItemtitle">${threadName}</span><pre class="ConversationItemHinttextBox">${view.preview}</pre></div>`
          }
        </div></div>
        <div class="StackLayoutpagespageRoot" id="panel" hidden>
          <div class="StackLayoutStackTitleBartitleBar"><span class="StackLayoutStackChatHeadertitle">${threadName}</span></div>
          <div class="messageMessageListlist" id="messages" ${view.busy ? 'aria-busy="true"' : ""}>${view.rows ?? ""}</div>
          ${
            view.locked
              ? '<div role="alert">对方回复前，不能再发送消息</div>'
              : `
            <div data-e2e="msg-input"><div id="composer" class="messageEditorinputArea" contenteditable="true" data-placeholder="发送消息"
              ${scenario.onInput ? 'oninput="messages.replaceChildren(typed.content.cloneNode(true))"' : ""}
              onkeydown="if (event.key === 'Enter') {event.preventDefault(); recordSubmit().then(() => {
                if (!${!!scenario.keepDraft}) composer.textContent = '';
                messages.append(post.content.cloneNode(true));
              })}"></div><svg class="e2e-send-msg-btn"></svg></div>`
          }
        </div></div></div><template id="post">${scenario.afterEnter ?? ""}</template><template id="typed">${scenario.onInput ?? ""}</template>`;
      },
      undefined,
      scenario.text ?? messageBody,
    );
    if (scenario.success) await f.run();
    else
      await expect(f.run()).rejects.toMatchObject({
        code: "DM_OUTCOME_UNKNOWN",
        ...(scenario.keepDraft && {
          message: expect.stringContaining("仍保留原草稿"),
        }),
      });
    expect(f.submits()).toBe(1);
    expect(visits).toBe(scenario.success ? scenario.history.length : 2);
  });
}
