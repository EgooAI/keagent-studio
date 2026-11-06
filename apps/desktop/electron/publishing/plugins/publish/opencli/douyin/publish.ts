// @ts-nocheck
import { PublishingError } from "../../../../core";
import {
  uploadContext,
  progress,
  warnPrecheck,
} from "../../../../runtime-context";
/*
 * Adapted from jackwener/opencli commit 0e73c3c2c2b45c91e050e1618b20e2aba22f1a23.
 * Licensed under Apache-2.0. Modified for AutoUp module imports, TypeScript compilation,
 * and immediate publishing. The schedule=0 convention follows dreammis/social-auto-upload
 * commit 008e4ff66abdf48eb1f4b999272ef979711af436 (MIT declared by that project).
 */
// @ts-nocheck
/**
 * Douyin publish — 8-phase pipeline for scheduling video posts.
 *
 * Phases:
 *   1. upload auth v5 credentials
 *   2. Apply TOS upload URL
 *   3. TOS multipart upload
 *   4. Cover upload (optional, via ImageX)
 *   5. Enable video
 *   6. Poll transcode
 *   7. Content safety check
 *   8. create_v2 publish
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { cli, Strategy } from "../../opencli-shim/registry.js";
import {
  ArgumentError,
  CommandExecutionError,
} from "../../opencli-shim/errors.js";
import {
  getUploadAuthV5Credentials,
  applyVideoUploadInner,
  commitVideoUploadInner,
} from "./_shared/vod-upload.js";
import { tosUpload } from "./_shared/tos-upload.js";
import { imagexUpload } from "./_shared/imagex-upload.js";
import { browserFetch } from "./_shared/browser-fetch.js";
import { requireObjectEvaluateResult } from "./_shared/evaluate-result.js";
import { generateCreationId } from "./_shared/creation-id.js";
import { validateTiming, toUnixSeconds } from "./_shared/timing.js";
import { parseTextExtra, extractHashtagNames } from "./_shared/text-extra.js";
const VISIBILITY_MAP = {
  public: 0,
  friends: 1,
  private: 2,
};
const IMAGEX_BASE = "https://imagex.bytedanceapi.com";
const IMAGEX_SERVICE_ID = "1147";
const DEVICE_PARAMS =
  "aid=1128&cookie_enabled=true&screen_width=1512&screen_height=982&browser_language=zh-CN&browser_platform=MacIntel&browser_name=Mozilla&browser_online=true&timezone_name=Asia%2FTokyo&support_h265=1";
const DEFAULT_COVER_TOOLS_INFO = JSON.stringify({
  video_cover_source: 2,
  cover_timestamp: 0,
  recommend_timestamp: 0,
  is_cover_edit: 0,
  is_cover_template: 0,
  cover_template_id: "",
  is_text_template: 0,
  text_template_id: "",
  text_template_content: "",
  is_text: 0,
  text_num: 0,
  text_content: "",
  is_use_sticker: 0,
  sticker_id: "",
  is_use_filter: 0,
  filter_id: "",
  is_cover_modify: 0,
  to_status: 0,
  cover_type: 0,
  initial_cover_uri: "",
  cut_coordinate: "",
});
function isFastDetectRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("post_assistant/fast_detect") &&
    (message.includes("Empty response") ||
      message.includes("404") ||
      message.includes("Not Found") ||
      message.includes("Timeout") ||
      message.includes("timed out") ||
      message.includes("Failed to fetch"))
  );
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function throwIfImagexError(action, payload) {
  const error = payload?.ResponseMetadata?.Error ?? payload?.Error;
  if (error) {
    throw new CommandExecutionError(`${action}失败: ${JSON.stringify(error)}`);
  }
}
async function tryFastDetectFetch(page, method, url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return {
        ok: true,
        value: await browserFetch(page, method, url, options),
      };
    } catch (error) {
      if (!isFastDetectRetryable(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    }
  }
  return { ok: false, error: lastError };
}
cli({
  site: "douyin",
  name: "publish",
  access: "write",
  description:
    "立即或定时发布视频到抖音（0 表示立即，定时需设置 2h ~ 14天后的发布时间）",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "video", required: true, positional: true, help: "视频文件路径" },
    { name: "title", required: true, help: "视频标题（≤30字）" },
    {
      name: "schedule",
      required: true,
      help: "发布时间（0 表示立即；定时使用 ISO8601 或 Unix 秒，2h ~ 14天后）",
    },
    { name: "caption", default: "", help: "正文内容（≤1000字，支持 #话题）" },
    {
      name: "cover",
      default: "",
      help: "封面图片路径（不提供时使用视频截帧）",
    },
    {
      name: "visibility",
      default: "public",
      choices: ["public", "friends", "private"],
    },
    { name: "allow_download", type: "bool", default: false, help: "允许下载" },
    { name: "collection", default: "", help: "合集 ID" },
    { name: "activity", default: "", help: "活动 ID" },
    { name: "poi_id", default: "", help: "地理位置 ID" },
    { name: "poi_name", default: "", help: "地理位置名称" },
    { name: "hotspot", default: "", help: "关联热点词" },
    {
      name: "no_safety_check",
      type: "bool",
      default: false,
      help: "跳过内容安全检测",
    },
    {
      name: "sync_toutiao",
      type: "bool",
      default: false,
      help: "同步发布到头条",
    },
  ],
  columns: ["status", "aweme_id", "url", "publish_time"],
  func: async (page, kwargs) => {
    // ── Fail-fast validation ────────────────────────────────────────────
    const videoPath = path.resolve(kwargs.video);
    if (!fs.existsSync(videoPath)) {
      throw new ArgumentError(`视频文件不存在: ${videoPath}`);
    }
    const ext = path.extname(videoPath).toLowerCase();
    if (![".mp4", ".mov", ".avi", ".webm"].includes(ext)) {
      throw new ArgumentError(
        `不支持的视频格式: ${ext}（支持 mp4/mov/avi/webm）`,
      );
    }
    const fileSize = fs.statSync(videoPath).size;
    const title = kwargs.title;
    if (title.length > 30) {
      throw new ArgumentError("标题不能超过 30 字");
    }
    const caption = kwargs.caption || "";
    if (caption.length > 1000) {
      throw new ArgumentError("正文不能超过 1000 字");
    }
    const timingTs = toUnixSeconds(kwargs.schedule);
    const immediate = timingTs === 0;
    // The creator page leaves timing at 0 for immediate publishing. Only
    // native schedules are subject to Douyin's 2-hour to 14-day window.
    if (!immediate) validateTiming(timingTs);
    const visibilityType = VISIBILITY_MAP[kwargs.visibility] ?? 0;
    const coverPath = kwargs.cover;
    if (coverPath) {
      if (!fs.existsSync(path.resolve(coverPath))) {
        throw new ArgumentError(`封面文件不存在: ${path.resolve(coverPath)}`);
      }
    }
    // ── Phase 1: upload credentials ────────────────────────────────────
    const credentials = await uploadContext().steps.run(
      "upload_auth",
      "获取上传凭证",
      () => getUploadAuthV5Credentials(page),
    );
    // ── Phase 2: Apply TOS upload URL ───────────────────────────────────
    const tosUploadInfo = await uploadContext().steps.run(
      "apply_upload",
      "申请视频上传",
      () => applyVideoUploadInner(fileSize, credentials),
    );
    let coverUri = "";
    let coverWidth = 720;
    let coverHeight = 1280;
    // ── Phase 3: TOS upload ─────────────────────────────────────────────
    await uploadContext().steps.run("upload_video", "上传视频分片", () =>
      tosUpload({
        filePath: videoPath,
        uploadInfo: tosUploadInfo,
        credentials,
        resumeDir: kwargs.__autoup_resume_dir,
        onProgress: (uploaded, total) => {
          progress(uploaded, total);
        },
      }),
    );
    const committedVideo = await uploadContext().steps.run(
      "commit_video",
      "提交视频上传",
      () => commitVideoUploadInner(tosUploadInfo, credentials),
    );
    const videoId = committedVideo.video_id;
    coverWidth = committedVideo.width || coverWidth;
    coverHeight = committedVideo.height || coverHeight;
    if (!coverUri && committedVideo.poster_uri) {
      coverUri = committedVideo.poster_uri;
    }
    // ── Phase 4: Cover upload (optional) ────────────────────────────────
    if (kwargs.cover) {
      const resolvedCoverPath = path.resolve(kwargs.cover);
      // 4A: Apply ImageX upload
      const applyUrl = `${IMAGEX_BASE}/?Action=ApplyImageUpload&ServiceId=${IMAGEX_SERVICE_ID}&Version=2018-08-01&UploadNum=1`;
      const applyJs = `fetch(${JSON.stringify(applyUrl)}, { credentials: 'include' }).then(r => r.json())`;
      const applyRes = requireObjectEvaluateResult(
        await page.evaluate(applyJs),
        "抖音封面申请上传地址响应异常",
      );
      throwIfImagexError("抖音封面申请上传地址", applyRes);
      const imgStoreInfo = applyRes.Result?.UploadAddress?.StoreInfos?.[0];
      if (!imgStoreInfo?.UploadHost || !imgStoreInfo?.StoreUri) {
        throw new CommandExecutionError(
          `抖音封面申请上传地址响应缺少 UploadHost/StoreUri: ${JSON.stringify(applyRes).slice(0, 500)}`,
        );
      }
      const imgUploadUrl = `https://${imgStoreInfo.UploadHost}/${imgStoreInfo.StoreUri}`;
      // 4B: Upload image
      const coverStoreUri = await uploadContext().steps.run(
        "upload_cover",
        "上传封面",
        () =>
          imagexUpload(resolvedCoverPath, {
            upload_url: imgUploadUrl,
            store_uri: imgStoreInfo.StoreUri,
          }),
      );
      // 4C: Commit ImageX upload
      const commitUrl = `${IMAGEX_BASE}/?Action=CommitImageUpload&ServiceId=${IMAGEX_SERVICE_ID}&Version=2018-08-01`;
      const commitBody = JSON.stringify({ SuccessObjKeys: [coverStoreUri] });
      const commitJs = `
        fetch(${JSON.stringify(commitUrl)}, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: ${JSON.stringify(commitBody)}
        }).then(r => r.json())
      `;
      const commitRes = requireObjectEvaluateResult(
        await page.evaluate(commitJs),
        "抖音封面提交上传响应异常",
      );
      throwIfImagexError("抖音封面提交上传", commitRes);
      coverUri = coverStoreUri;
    }
    // The gateway upload flow returns a committed VOD upload result; the legacy
    // enable/transend endpoints can hang for that flow, so create_v2 consumes
    // the committed video_id and poster metadata directly.
    // ── Phase 7: Content safety check ───────────────────────────────────
    if (!kwargs.no_safety_check) {
      const safetyUrl =
        "https://creator.douyin.com/aweme/v1/post_assistant/fast_detect/pre_check";
      const safetyBody = {
        video_id: videoId,
        title,
        desc: caption,
      };
      const preCheck = await uploadContext().steps.run(
        "safety_precheck",
        "提交内容预检",
        () => tryFastDetectFetch(page, "POST", safetyUrl, { body: safetyBody }),
      );

      const pollUrl =
        "https://creator.douyin.com/aweme/v1/post_assistant/fast_detect/poll";
      const deadline = Date.now() + 30_000;
      let safetyPassed = false;
      let pollUnavailableCount = 0;
      while (Date.now() < deadline) {
        const poll = await tryFastDetectFetch(page, "POST", pollUrl, {
          body: safetyBody,
        });
        if (!poll.ok) {
          pollUnavailableCount += 1;
          if (!preCheck.ok && pollUnavailableCount >= 3) {
            break;
          }
          await sleep(2000);
          continue;
        }
        pollUnavailableCount = 0;
        const pollRes = poll.value;
        if (
          pollRes.status === 0 ||
          (pollRes.has_done === true &&
            pollRes.detect_result?.reason_code === 0 &&
            (pollRes.detect_list?.length ?? 0) === 0)
        ) {
          safetyPassed = true;
          break;
        }
        if (pollRes.status === 1) {
          throw new PublishingError(
            "CONTENT_REJECTED",
            "内容安全检测不通过，请修改后重试",
          );
        }
        await sleep(2000);
      }
      if (!safetyPassed) {
        if (!preCheck.ok && pollUnavailableCount >= 3) {
          warnPrecheck();
        } else {
          throw new PublishingError(
            "PRECHECK_TIMEOUT",
            "内容安全检测超时，请稍后重新操作",
          );
        }
      }
    }
    // ── Phase 8: create_v2 publish ──────────────────────────────────────
    const hashtagNames = extractHashtagNames(caption);
    const hashtags = [];
    let searchFrom = 0;
    for (const name of hashtagNames) {
      const idx = caption.indexOf(`#${name}`, searchFrom);
      if (idx === -1) continue;
      hashtags.push({ name, id: 0, start: idx, end: idx + name.length + 1 });
      searchFrom = idx + name.length + 1;
    }
    const publishText = caption ? `${title} ${caption}` : title;
    const captionOffset = caption ? title.length + 1 : 0;
    const textExtraArr = parseTextExtra(
      publishText,
      hashtags.map((hashtag) => ({
        ...hashtag,
        start: hashtag.start + captionOffset,
        end: hashtag.end + captionOffset,
      })),
    );
    const publishBody = {
      item: {
        common: {
          text: publishText,
          caption: caption,
          item_title: title,
          activity: JSON.stringify(kwargs.activity ? [kwargs.activity] : []),
          text_extra: JSON.stringify(textExtraArr),
          challenges: "[]",
          mentions: "[]",
          hashtag_source: "",
          hot_sentence: kwargs.hotspot || "",
          interaction_stickers: "[]",
          visibility_type: visibilityType,
          download: kwargs.allow_download ? 1 : 0,
          timing: timingTs,
          creation_id: generateCreationId(),
          media_type: 4,
          video_id: videoId,
          music_source: 0,
          music_id: null,
          ...(kwargs.poi_id
            ? { poi_id: kwargs.poi_id, poi_name: kwargs.poi_name }
            : {}),
        },
        cover: {
          poster: coverUri,
          custom_cover_image_height: coverHeight,
          custom_cover_image_width: coverWidth,
          poster_delay: 0,
          cover_tools_info: DEFAULT_COVER_TOOLS_INFO,
          cover_tools_extend_info: "{}",
        },
        mix: kwargs.collection
          ? { mix_id: kwargs.collection, mix_order: 0 }
          : {},
        chapter: {
          chapter: JSON.stringify({
            chapter_abstract: "",
            chapter_details: [],
            chapter_type: 0,
          }),
        },
        anchor: {},
        sync: {
          should_sync: false,
          sync_to_toutiao: kwargs.sync_toutiao ? 1 : 0,
        },
        open_platform: {},
        assistant: { is_preview: 0, is_post_assistant: 1 },
        declare: { user_declare_info: "{}" },
      },
    };
    const publishUrl = `https://creator.douyin.com/web/api/media/aweme/create_v2/?read_aid=2906&${DEVICE_PARAMS}`;
    await uploadContext().beforeSubmit();
    const publishRes = await browserFetch(page, "POST", publishUrl, {
      once: true,
      body: publishBody,
    });
    const awemeId = publishRes.aweme_id ?? publishRes.item_id;
    if (
      !awemeId ||
      (typeof awemeId !== "string" && !Number.isSafeInteger(awemeId))
    ) {
      throw new CommandExecutionError(
        `发布成功但未返回 aweme_id/item_id: ${JSON.stringify(publishRes)}`,
      );
    }
    const url = `https://www.douyin.com/video/${awemeId}`;
    const publishTimeStr = immediate
      ? "立即发布"
      : new Date(timingTs * 1000).toLocaleString("zh-CN", {
          timeZone: "Asia/Tokyo",
        });
    return [
      {
        status: immediate ? "✅ 发布成功！" : "✅ 定时发布成功！",
        aweme_id: awemeId,
        url,
        publish_time: publishTimeStr,
      },
    ];
  },
});
