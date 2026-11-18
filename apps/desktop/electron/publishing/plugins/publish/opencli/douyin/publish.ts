import { setTimeout as delay } from "node:timers/promises";
import {
  douyinCaption,
  formatDouyinSchedule,
  validateDouyinSchedule,
  type DouyinPublishInput,
} from "@keagent/shared-types";
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
const dateInput =
  'input[placeholder="日期和时间"]:not([disabled]):not([readonly])';

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

async function uploadCover(
  page: OpenCliPage,
  file: string,
  signal: AbortSignal,
  assertPage: () => void,
) {
  // The card label identifies the ratio, but the click handler is on its preview.
  const card = 'div[class*="coverControl-"]';
  const preview = `${card} > div[class^="cover-"]:not([class^="cover-tip-"])`;
  const editor = '[class*="coverSelect-"]';
  const directUpload = '[class*="upload-tips-"]';
  const uploadControl = {
    ...label("上传封面"),
    within: `${editor}, ${directUpload}`,
  };
  const directInput = `${directUpload} + [class*="upload-"] input.semi-upload-hidden-input[type="file"][accept*="image"]:not(:disabled)`;
  const directPreview = `div:has(> ${directUpload}) > [class*="bg-"][style*="background-image"]`;
  const uploadArea = {
    ...label("点击上传"),
    exactText: false,
    within: editor,
  };
  const cropComplete = {
    ...button("完成"),
    within: `${editor} [class*="uploadCrop-"]`,
  };
  const editorComplete = button("完成");
  const skipHorizontal = button("暂不设置");
  const success = label("封面上传成功");
  const rejected = {
    selector: ":is(div, span, p):not(:has(div, span, p))",
    text: "封面失败",
  };
  const options = { origin, signal };

  try {
    await page.waitForElement(
      { selector: card, text: "竖封面3:4" },
      "visible",
      15_000,
      signal,
    );
    const index = await page.evaluate<number>(`(() => {
      return [...document.querySelectorAll(${JSON.stringify(preview)})].findIndex(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 &&
          element.parentElement.textContent.replace(/\\s+/g, '').includes('竖封面3:4');
      });
    })()`);
    if (index < 0) throw new Error("The vertical cover preview is unavailable");
    await page.clickElement({ selector: preview, index }, options);
    await page.waitForElement(uploadControl, "visible", 15_000, signal);
    const direct = await page.isElementVisible({
      ...uploadControl,
      within: directUpload,
    });
    if (direct) {
      // The full editor has separate inputs for adding and replacing images.
      await page.waitForElement(
        { selector: directInput },
        "attached",
        15_000,
        signal,
      );
      await page.setFileInput([file], directInput, options);
    } else {
      await page.clickElement(uploadControl, options);
      await page.waitForElement(uploadArea, "visible", 15_000, signal);
      await page.chooseFiles(uploadArea, [file], 10_000, options);
    }

    const complete = direct ? editorComplete : cropComplete;
    const savedPreview = () =>
      page.evaluate<string>(`(() => {
        const img = document.querySelectorAll(${JSON.stringify(preview)})[${index}]?.querySelector('img');
        return img?.complete && img.naturalWidth > 0 ? img.currentSrc : '';
      })()`);

    const readyBy = Date.now() + 15_000;
    while (true) {
      assertPage();
      if (
        (await page.isElementVisible({
          ...label("不支持的图片格式"),
          exactText: false,
        })) ||
        (await page.isElementVisible({
          ...label("分辨率过低"),
          exactText: false,
        }))
      )
        throw new PublishingError(
          "COVER_UPLOAD_FAILED",
          "抖音拒绝了封面图片的格式或尺寸",
        );
      if (
        (await page.isElementVisible(complete)) &&
        (!direct || (await page.isElementVisible({ selector: directPreview })))
      )
        break;
      if (Date.now() >= readyBy) throw new Error("The cover crop is not ready");
      await delay(100, undefined, { signal });
    }
    const previousPreview = direct ? await savedPreview() : "";
    await page.clickElement(complete, options);

    const deadline = Date.now() + 30_000;
    const editorControl = direct ? directUpload : editor;
    const closingDialog =
      '[role="dialog"][class*="modal-content-animate-hide"]';
    const editorOpen = () =>
      page.evaluate<boolean>(`(() => {
        const controls = document.querySelectorAll(${JSON.stringify(editorControl)});
        return [...controls].some(element =>
          element.getClientRects().length > 0 &&
          element.checkVisibility({opacityProperty: true, visibilityProperty: true}) &&
          !element.closest(${JSON.stringify(closingDialog)})
        );
      })()`);
    const finishEditorExit = async () => {
      assertPage();
      await page.evaluate(`(() => {
        if (location.origin !== ${JSON.stringify(origin)}) return;
        for (const dialog of document.querySelectorAll(${JSON.stringify(closingDialog)})) {
          if (!dialog.querySelector(${JSON.stringify(editorControl)})) continue;
          const layer = dialog.closest('[class*="modal-wrap"]');
          const maskSelector = '[class*="modal-mask-animate-hide"]';
          const masks = [
            ...(layer?.querySelectorAll(maskSelector) ?? []),
            ...(layer?.parentElement?.querySelectorAll(':scope > ' + maskSelector) ?? []),
          ];
          // A hidden publishing view can leave the exit animation at its first frame.
          // Only the exiting cover dialog and its closing masks should stop taking input.
          for (const element of [dialog, ...masks]) {
            element.inert = true;
            for (const animation of element.getAnimations()) {
              if (animation.playbackRate !== 0 && animation.effect &&
                  Number.isFinite(animation.effect.getComputedTiming().endTime))
                animation.finish();
            }
          }
          if (layer && [...layer.querySelectorAll('[role="dialog"]')].every(other =>
            other.matches(${JSON.stringify(closingDialog)}))) layer.inert = true;
        }
      })()`);
    };
    let uploaded = false;
    let declinedHorizontal = false;
    while (Date.now() < deadline) {
      assertPage();
      if (
        (await page.isElementVisible(rejected)) ||
        (await page.isElementVisible({ ...rejected, text: "封面上传失败" }))
      )
        break;
      if (direct) {
        if (
          !declinedHorizontal &&
          (await page.isElementVisible(skipHorizontal))
        ) {
          await page.clickElement(skipHorizontal, options);
          declinedHorizontal = true;
        }
        // Douyin can leave the closing dialog mounted while its cover preview updates.
        if (!(await editorOpen())) {
          const currentPreview = await savedPreview();
          if (currentPreview && currentPreview !== previousPreview) {
            await finishEditorExit();
            return;
          }
        }
      } else {
        uploaded ||= await page.isElementVisible(success);
        if (uploaded && !(await editorOpen())) {
          await finishEditorExit();
          return;
        }
      }
      await delay(100, undefined, { signal });
    }
    throw new Error("The creator page did not confirm the cover upload");
  } catch (error) {
    assertPage();
    if (error instanceof PublishingError) throw error;
    throw new PublishingError("COVER_UPLOAD_FAILED", "抖音未能确认封面已上传");
  }
}

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
  const scheduledAt = input.scheduledAt;
  const scheduleMode = scheduledAt === undefined ? "立即发布" : "定时发布";
  const isSettingChecked = (text: string) =>
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
  const checkSchedule = async (seconds: number) => {
    assertPage();
    const invalid = validateDouyinSchedule(seconds);
    if (invalid) throw new PublishingError("INVALID_SCHEDULE", invalid);
    const actual = await page.evaluate<string>(`(() => {
      const fields = [...document.querySelectorAll(${JSON.stringify(dateInput)})]
        .filter(field => field.getClientRects().length);
      return fields.length === 1 ? fields[0].value : '';
    })()`);
    const normalized = actual
      .trim()
      .replace(/[年/月]/g, "-")
      .replace(/日/, "")
      .replace(/\s+/g, " ");
    return (
      normalized === formatDouyinSchedule(seconds) &&
      (await isSettingChecked("定时发布"))
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

  await steps.run("upload_cover", "通过网页上传竖版封面", () =>
    uploadCover(page, files.cover, signal, assertPage),
  );

  await steps.run("publish_settings", "核对网页发布设置", async () => {
    for (const [step, text] of [
      ["set_crosspost", "不同时发布"],
      ["set_visibility", "公开"],
      ["set_download", "不允许"],
      ["set_schedule", scheduleMode],
    ]) {
      await steps.run(step, text, async () => {
        const checked = () => isSettingChecked(text);
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
    if (scheduledAt !== undefined) {
      await steps.run(
        "set_scheduled_time",
        "写入并核对抖音预约时间",
        async () => {
          await wait({ selector: dateInput });
          await click({ selector: dateInput });
          await page.replaceText(
            formatDouyinSchedule(scheduledAt),
            dateInput,
            options,
          );
          // Commit the date picker without triggering a form's default Enter action.
          await page.evaluate(`(() => {
          const input = document.activeElement;
          if (location.origin !== ${JSON.stringify(origin)} ||
              !input?.matches(${JSON.stringify(dateInput)})) return;
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
          }));
          input.blur();
        })()`);
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline) {
            if (await checkSchedule(scheduledAt)) return;
            await delay(100, undefined, { signal });
          }
          throw new PublishingError(
            "SCHEDULE_TIME_MISMATCH",
            "抖音页面未保留预约时间",
          );
        },
      );
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
        async () => {
          if (scheduledAt !== undefined && !(await checkSchedule(scheduledAt)))
            throw new PublishingError(
              "SCHEDULE_TIME_MISMATCH",
              "提交前预约时间已变化",
            );
          await beforeSubmit();
        },
        () => page.clickElement(publish, options),
        signal,
        scheduledAt === undefined
          ? undefined
          : (body) =>
              Number(JSON.parse(body).item?.common?.timing) === scheduledAt,
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
  if (scheduledAt !== undefined && code !== 0 && code !== "0")
    throw new Error("The platform did not confirm scheduled submission");
  const id = receipt?.item_id ?? receipt?.aweme_id;
  const externalId =
    typeof id === "string" || Number.isSafeInteger(id) ? String(id) : "";
  if (!/^\d{5,30}$/.test(externalId))
    throw new Error("The platform receipt did not include a valid work ID");
  return { externalId, url: `https://www.douyin.com/video/${externalId}` };
}
