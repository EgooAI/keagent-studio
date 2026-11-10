import { setTimeout as delay } from "node:timers/promises";
import { douyinCaption, type DouyinPublishInput } from "@keagent/shared-types";
import {
  ConfirmedPublishRejection,
  PublishingError,
  type PublishFiles,
} from "../../../../core";
import type {
  OpenCliPage,
  PublishPageElementQuery,
} from "../../../../runtime/browser/opencli-page";
import type { ExecutionStepReporter } from "../../../../runtime/task-executor/execution-log";

const origin = "https://creator.douyin.com";
const uploadPage = origin + "/creator-micro/content/upload";
const publishEndpoint = origin + "/web/api/media/aweme/create_v2/";
const title = 'input[placeholder*="填写作品标题"]';
const caption = '[contenteditable="true"][data-placeholder="添加作品简介"]';

const button = (text: string): PublishPageElementQuery => ({
  selector: 'button:not([disabled]):not([aria-disabled="true"])',
  text,
  exactText: true,
});
const label = (text: string): PublishPageElementQuery => ({
  selector: ":is(div, span, label, p):not(:has(div, span, label, p))",
  text,
  exactText: true,
});

export async function publishFromCreatorPage(
  page: OpenCliPage,
  input: DouyinPublishInput,
  files: PublishFiles,
  signal: AbortSignal,
  steps: ExecutionStepReporter,
  beforeSubmit: () => Promise<void>,
  progress: (value: number) => void,
): Promise<{ externalId: string; url: string }> {
  const options = { origin, signal };
  const assertPage = () => {
    signal.throwIfAborted();
    if (new URL(page.getUrl()).origin !== origin)
      throw new PublishingError("LOGIN_REQUIRED", "请在账号浏览器重新登录抖音");
  };
  const wait = (query: PublishPageElementQuery, timeoutMs?: number) =>
    page.waitForElement(query, "visible", timeoutMs, signal);
  const click = async (query: PublishPageElementQuery) => {
    await wait(query);
    await page.clickElement(query, options);
  };
  const assertVideoAvailable = async () => {
    assertPage();
    if (await page.isElementVisible(label("上传失败，重新上传")))
      throw new PublishingError(
        "VIDEO_UPLOAD_FAILED",
        "抖音网页报告视频上传失败",
      );
  };

  await page.goto(uploadPage);
  assertPage();
  await steps.run("upload_video", "通过网页上传视频", async () => {
    const upload = button("上传视频");
    await wait(upload, 30_000);
    await page.chooseFiles(upload, [files.video], 10_000, options);
    progress(20);
    // The editor is displayed during upload. The preview toolbar requires a video ID.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await assertVideoAvailable();
      if (
        (await page.isElementVisible(label("重新上传"))) &&
        !(await page.isElementVisible(label("取消上传")))
      )
        return;
      await delay(250, undefined, { signal });
    }
    throw new PublishingError(
      "VIDEO_UPLOAD_TIMEOUT",
      "等待抖音网页完成视频上传超时",
    );
  });

  await steps.run("fill_publish_form", "填写发布文案", async () => {
    const tip = button("我知道了");
    if (await page.isElementVisible(tip)) await click(tip);
    await click({ selector: title });
    await page.replaceText(input.title, title, options);
    await click({ selector: caption });
    await page.replaceText(
      douyinCaption(input.description, input.hashtags),
      caption,
      options,
    );
  });
  progress(55);

  await steps.run("publish_settings", "核对网页发布设置", async () => {
    for (const [step, text] of [
      ["set_crosspost", "不同时发布"],
      ["set_visibility", "公开"],
      ["set_download", "不允许"],
      ["set_schedule", "立即发布"],
    ]) {
      await steps.run(step, text, async () => {
        const checked = () =>
          page.evaluate<boolean>(`(() => {
        const expected = ${JSON.stringify(text)};
        return [...document.querySelectorAll('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]')].some(control => {
          if (control.checked !== true && control.getAttribute('aria-checked') !== 'true') return false;
          const names = [
            control.getAttribute('aria-label'),
            ...Array.from(control.labels || [], label => label.textContent),
            control.textContent,
            control.parentElement?.textContent,
            control.closest('label')?.textContent,
          ];
          return names.some(name => name?.trim() === expected);
        });
      })()`);
        if (await checked()) return;
        await click(label(text));
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          assertPage();
          if (await checked()) return;
          await delay(100, undefined, { signal });
        }
        throw new Error("The creator page did not retain the publish setting");
      });
    }
  });
  progress(80);
  const publish = button("发布");
  await assertVideoAvailable();
  await wait(publish, 90_000);
  await assertVideoAvailable();
  progress(90);

  const raw = await steps.run(
    "submit_page_request",
    "点击发布并等待平台回执",
    () =>
      page.capturePostResponse(
        publishEndpoint,
        beforeSubmit,
        () => page.clickElement(publish, options),
        signal,
      ),
  );
  const receipt = JSON.parse(
    raw,
    (key, value, context?: { source: string }) => {
      // The browser response may encode a 64-bit work ID as a JSON number.
      if (
        (key === "item_id" || key === "aweme_id") &&
        typeof value === "number" &&
        context
      )
        return context.source;
      return value;
    },
  );
  const code = receipt?.status_code;
  if (
    (typeof code === "number" ||
      (typeof code === "string" && /^-?\d+$/.test(code))) &&
    Number(code) !== 0
  ) {
    throw new ConfirmedPublishRejection(
      "PLATFORM_REJECTED",
      "抖音明确拒绝了本次提交",
    );
  }
  const id = receipt?.item_id ?? receipt?.aweme_id;
  const externalId =
    typeof id === "string" || Number.isSafeInteger(id) ? String(id) : "";
  if (!/^\d{5,30}$/.test(externalId))
    throw new Error("The platform receipt did not include a valid work ID");
  return { externalId, url: `https://www.douyin.com/video/${externalId}` };
}
