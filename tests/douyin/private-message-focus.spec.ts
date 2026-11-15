import { expect, test } from "@playwright/test";
import { conversation } from "../../apps/desktop/electron/social/message-conversation";

test("私信输入后焦点切到另一同源编辑器时，阻止提交", async ({ page }) => {
  const profile = "https://www.douyin.com/user/target";
  const text = "仅本地测试";
  await page.route("**/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/user/target"
        ? '<div data-e2e="user-detail"><button onclick="chat.hidden=false">私信</button></div><iframe hidden id="chat" src="/fixture-chat"></iframe><iframe id="other" src="/fixture-other"></iframe>'
        : path === "/fixture-chat"
          ? '<section class="chat-panel"><textarea></textarea><button onclick="this.dataset.clicked=1">发送</button></section>'
          : "<textarea></textarea>";
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  await page.goto(profile);
  const chat = page.frameLocator("#chat");
  const run = (action: Parameters<typeof conversation>[0]) =>
    page.evaluate<ReturnType<typeof conversation>>(
      "(" +
        conversation.toString() +
        ")(" +
        [action, profile, text, 0].map((v) => JSON.stringify(v)).join(",") +
        ")",
    );
  await page.frameLocator("#other").locator("textarea").waitFor();
  expect((await run("inspect")).ready).toBe(false);
  expect((await run("open")).ready).toBe(true);
  await chat.locator("textarea").waitFor();
  expect((await run("focus")).ready).toBe(true);
  await chat.locator("textarea").fill(text);
  expect((await run("focused")).ready).toBe(true);
  const other = page.frameLocator("#other").locator("textarea");
  await other.focus();
  expect((await run("focused")).ready).toBe(false);
  expect((await run("submit")).ready).toBe(false);
  expect((await run("enter")).ready).toBe(false);
  await expect(other).toHaveValue("");
  await expect(chat.locator("button")).not.toHaveAttribute("data-clicked", "1");
});
