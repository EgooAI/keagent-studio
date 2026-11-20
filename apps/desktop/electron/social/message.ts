import { setTimeout as delay } from "node:timers/promises";
import type { DouyinMessageStep } from "@keagent/shared-types";
import { PublishingError } from "../publishing/core";
import {
  isNavigationEvaluationError,
  type OpenCliPage,
} from "../publishing/runtime/browser/opencli-page";
import { conversation } from "./message-conversation";
const douyinProfile = /^https:\/\/www\.douyin\.com\/user\/[\w-]{1,256}$/;

export interface MessageInput {
  platform: "douyin" | "xhs";
  accountId: string;
  profileUrl: string;
  recipientName: string;
  text: string;
  requestKey: string;
  source?: { workId: string; commentId: string };
}

export interface MessageExecutionSteps {
  start(step: DouyinMessageStep): void;
  complete(): void;
}

const MESSAGE_STEP_INTERVAL_MS = 2000;
const MESSAGE_RECEIPT_INTERVAL_MS = 3000;

export function validateMessage(input: MessageInput) {
  const profile =
    input?.platform === "douyin"
      ? douyinProfile
      : /^https:\/\/www\.xiaohongshu\.com\/user\/profile\/[a-f\d]{24}$/i;
  if (
    !input ||
    !["xhs", "douyin"].includes(input.platform) ||
    !/^[a-f0-9]{32}$/.test(input.accountId) ||
    !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i.test(input.requestKey) ||
    typeof input.profileUrl !== "string" ||
    !profile.test(input.profileUrl) ||
    typeof input.recipientName !== "string" ||
    input.recipientName.length > 256 ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    Array.from(input.text).length > 320
  )
    throw new PublishingError(
      "INVALID_INPUT",
      "私信的账号、收件人、正文或请求编号无效",
      422,
    );
}

// CreatorHub's xhs_im parser reads these fields from the web client's normal history response.
function xhsSentIds(
  payload: unknown,
  sender: string,
  recipient: string,
  text: string,
  submittedAt = 0,
): string[] | undefined {
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const root = object(payload),
    data = object(root.data),
    rows = data.out_message_list ?? data.message_list;
  if (
    root.success === false ||
    (root.code !== undefined && String(root.code) !== "0") ||
    !Array.isArray(rows)
  )
    return;
  const ids: string[] = [];
  for (const raw of rows) {
    const row = object(raw);
    if (
      row.group_chat ||
      (row.sender_id ?? row.sender_uid) !== sender ||
      (row.receiver_id ?? row.receiver_uid) !== recipient
    )
      continue;
    if (submittedAt) {
      let stamp = Number(row.created_at ?? row.create_time);
      while (Number.isFinite(stamp) && stamp > 10000000000) stamp /= 1000;
      if (
        !Number.isFinite(stamp) ||
        stamp < Math.floor(submittedAt / 1000) - 2 ||
        stamp > Date.now() / 1000 + 120
      )
        continue;
    }
    let content = row.content;
    if (typeof content === "string")
      try {
        content = JSON.parse(content);
      } catch {
        /* Plain text. */
      }
    const body = object(content),
      nested = object(body.content);
    const message =
      typeof content === "string"
        ? content
        : typeof body.content === "string"
          ? body.content
          : (nested.text ?? nested.content ?? body.text);
    const id = row.id || row.uuid || row.store_id;
    if (
      message === text &&
      ((typeof id === "string" && id) ||
        (typeof id === "number" && Number.isSafeInteger(id) && id > 0))
    )
      ids.push(String(id));
  }
  return ids;
}

function messageChat(
  page: OpenCliPage,
  platform: MessageInput["platform"],
  url: URL,
  text: string,
  clock: { freshSince: number; submittedAt: number },
  signal: AbortSignal,
) {
  let afterProfileClick = false;
  const target =
    platform === "xhs"
      ? url.origin + "/chat/" + url.pathname.split("/").pop()
      : url.href;
  const script = (action: Parameters<typeof conversation>[0]) =>
    "(" +
    conversation.toString() +
    ")(" +
    [
      action,
      url.href,
      text,
      clock.freshSince,
      afterProfileClick,
      clock.submittedAt,
    ]
      .map((v) => JSON.stringify(v))
      .join(",") +
    ")";
  const run = async (action: Parameters<typeof conversation>[0]) => {
    signal.throwIfAborted();
    const navigating = action === "open" || action === "select";
    const startedAt =
      action === "open" && platform === "douyin"
        ? new URL(page.getUrl() || "about:blank")
        : undefined;
    let state: ReturnType<typeof conversation>;
    try {
      state = await page.inspectDocument<ReturnType<typeof conversation>>(
        script(action),
        navigating,
      );
    } catch (error) {
      // Navigation may destroy the document that handled the click. Never replay that click.
      if (
        (!navigating &&
          action !== "inspect" &&
          action !== "history" &&
          action !== "receipt") ||
        !isNavigationEvaluationError(error)
      )
        throw error;
      // A new same-origin chat page or popup can replace the target document during its click.
      const arrived = new URL(page.getUrl() || "about:blank");
      const enteredChat =
        startedAt?.origin === url.origin &&
        startedAt.pathname.replace(/\/$/, "") === url.pathname &&
        arrived.origin === url.origin &&
        (page.inMessagePopup ||
          /^\/(?:chat|im|message)\/[^/]/.test(arrived.pathname));
      return {
        ready: (navigating && platform === "xhs") || enteredChat,
        reason: "loading",
        count: 0,
        messages: [] as string[],
        delivered: 0,
        historyReady: false,
        endRow: "",
        previousRow: "",
        newestFirst: false,
        newestOwn: "",
        stackMatchCount: 0,
        stackChat: false,
        stackEmpty: false,
        firstOwn: "",
        stackPreviewMatches: false,
        stackPreviewConflict: false,
        stackListReady: false,
        stackBlank: false,
        firstOwnTimeMatches: false,
        draftCleared: false,
        draftStillPresent: false,
        receiptTexts: [] as string[],
      };
    }
    if (state.reason === "restricted")
      throw new PublishingError(
        action === "submit" ? "DM_NOT_DISPATCHED" : "DM_CONTACT_RESTRICTED",
        "平台提示当前无法向这位用户发送私信。请在平台查看联系限制。",
      );
    if (state.reason === "login")
      throw new PublishingError(
        action === "submit" ? "DM_NOT_DISPATCHED" : "LOGIN_REQUIRED",
        "平台要求登录或验证，请在 KeAgent 的平台账号页处理。",
      );
    return state;
  };
  async function openChat(read: "inspect" | "history" = "inspect") {
    afterProfileClick = false;
    await page.goto(target);
    if (platform === "douyin") {
      let retried = false;
      let sawChatSurface = false;
      let lastReason = "";
      let idleChecks = 0;
      let remaining = 48;
      while (remaining-- > 0) {
        const state = await run(afterProfileClick ? read : "open");
        lastReason = state.reason;
        if (
          afterProfileClick &&
          lastReason !== "profile-idle" &&
          lastReason !== "loading"
        )
          sawChatSurface = true;
        if (
          (state.reason === "origin" &&
            !["", "about:blank"].includes(page.getUrl())) ||
          state.reason === "wrong-profile" ||
          (!afterProfileClick && state.reason === "recipient")
        )
          throw new PublishingError(
            "DM_ENTRY_MISSING",
            "平台打开的页面与评论者主页不符，未进入私信。",
          );
        if (state.ready) {
          if (afterProfileClick) return;
          afterProfileClick = true;
        }
        idleChecks = state.reason === "profile-idle" ? idleChecks + 1 : 0;
        if (
          idleChecks >= 24 &&
          !retried &&
          !sawChatSurface &&
          !page.inMessagePopup &&
          !clock.submittedAt &&
          read === "inspect"
        ) {
          // Only reopen the target profile before drafting, with no chat surface on screen.
          retried = true;
          afterProfileClick = false;
          idleChecks = 0;
          await page.goto(target);
          remaining = 48;
        }
        await delay(250, undefined, { signal });
      }
      if (afterProfileClick && lastReason === "recipient")
        throw new PublishingError(
          "DM_RECIPIENT_UNVERIFIED",
          "页面同时出现多个聊天输入框，无法确认收件人。",
        );
      throw afterProfileClick
        ? new PublishingError(
            "DM_EDITOR_MISSING",
            lastReason === "profile-idle"
              ? "已点击收件人主页的私信入口，等待后仍未出现聊天面板。"
              : "已点击私信入口，但未能核对此次会话的输入框。",
          )
        : new PublishingError(
            "DM_ENTRY_MISSING",
            "在收件人主页没有找到可用的私信入口。",
          );
    }
    for (let i = 0; i < 10; i++) {
      const direct = await run("inspect");
      if (direct.ready) return;
      if (direct.reason === "recipient") break;
      await delay(250, undefined, { signal });
    }
    await page.goto(url.href);
    let opened = false,
      selected = false,
      recipientUnverified = false;
    for (let i = 0; i < 48; i++) {
      const state = await run("inspect");
      if (state.ready) return;
      if (state.reason === "recipient") recipientUnverified = true;
      if (!opened && !selected) opened = (await run("open")).ready;
      if (!selected) selected = (await run("select")).ready;
      await delay(250, undefined, { signal });
    }
    if (!opened && !selected && !recipientUnverified)
      throw new PublishingError(
        "DM_ENTRY_MISSING",
        "在收件人主页没有找到可用的私信入口。",
      );
    if (opened && !recipientUnverified && !selected)
      throw new PublishingError(
        "DM_EDITOR_MISSING",
        "已打开私信入口，但网页未显示可用的私信输入框。",
      );
    throw new PublishingError(
      "DM_RECIPIENT_UNVERIFIED",
      "网页未能确认当前聊天对象就是这位评论者，已停止发送。",
    );
  }
  return { script, run, openChat };
}

export async function verifyExistingSocialMessage(
  page: OpenCliPage,
  input: {
    profileUrl: string;
    submittedAt: number;
    matchesText: (body: string) => boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (
    !douyinProfile.test(input.profileUrl) ||
    !Number.isSafeInteger(input.submittedAt) ||
    input.submittedAt <= 0 ||
    input.submittedAt > Date.now()
  )
    return false;
  const clock = { freshSince: 0, submittedAt: input.submittedAt };
  const { run, openChat } = messageChat(
    page,
    "douyin",
    new URL(input.profileUrl),
    "",
    clock,
    signal,
  );
  await openChat("history");
  let previousMatch = "";
  for (let i = 0; i < 20; i++) {
    const snapshot = await run("receipt");
    const matches = snapshot.receiptTexts.filter(input.matchesText);
    const match = matches.length === 1 ? matches[0] : "";
    if (match && match === previousMatch) return true;
    previousMatch = match;
    await delay(300, undefined, { signal });
  }
  return false;
}

export async function sendSocialMessage(
  page: OpenCliPage,
  input: MessageInput,
  signal: AbortSignal,
  beforeSubmit: () => Promise<void>,
  senderId?: string,
  steps?: MessageExecutionSteps,
) {
  validateMessage(input);
  const url = new URL(input.profileUrl);
  const clock = { freshSince: 0, submittedAt: 0 };
  const { script, run, openChat } = messageChat(
    page,
    input.platform,
    url,
    input.text,
    clock,
    signal,
  );
  const recipient = url.pathname.split("/").pop()!;
  const baselineHistory = new Set<string>(),
    freshHistory = new Set<string>();
  let readBaseline = false;
  async function startStep(step: DouyinMessageStep) {
    const interval =
      step === "verify_conversation"
        ? MESSAGE_RECEIPT_INTERVAL_MS
        : MESSAGE_STEP_INTERVAL_MS;
    await delay(interval, undefined, { signal });
    steps?.start(step);
  }
  async function observeHistory(ids: Set<string>, read: () => Promise<void>) {
    if (input.platform !== "xhs" || !senderId || page.inMessagePopup)
      return read();
    return page.observeJsonResponses(
      (address) =>
        address.origin === "https://edith.xiaohongshu.com" &&
        address.pathname === "/api/im/web/messages/history" &&
        address.searchParams.get("chat_user_id") === recipient &&
        !Number(address.searchParams.get("last_id")) &&
        !Number(address.searchParams.get("start_id")),
      (_address, payload) => {
        const messages = xhsSentIds(
          payload,
          senderId,
          recipient,
          input.text,
          ids === freshHistory ? clock.submittedAt : 0,
        );
        if (!messages) return;
        if (ids === baselineHistory) readBaseline = true;
        for (const id of messages) ids.add(id);
      },
      read,
    );
  }
  await startStep("open_conversation");
  await observeHistory(baselineHistory, async () => {
    await openChat();
    if (input.platform === "xhs" && senderId && !page.inMessagePopup)
      for (let i = 0; i < 8 && !readBaseline; i++)
        await delay(200, undefined, { signal });
  });
  if (page.inMessagePopup) readBaseline = false;
  let baseline = await run("focus");
  const blankList = (state: Awaited<ReturnType<typeof run>>) =>
    state.stackBlank &&
    state.stackListReady &&
    !state.stackPreviewMatches &&
    !state.stackPreviewConflict;
  let blankSince = 0;
  let stableBlank = false;
  for (
    let i = 0;
    i < 8 && baseline.stackChat && !baseline.endRow && !baseline.stackEmpty;
    i++
  ) {
    if (blankList(baseline)) {
      if (!blankSince) blankSince = Date.now();
      if (Date.now() - blankSince >= 800) {
        stableBlank = true;
        break;
      }
    } else blankSince = 0;
    await delay(250, undefined, { signal });
    baseline = await run("inspect");
  }
  if (!baseline.ready)
    throw new PublishingError(
      input.platform === "douyin"
        ? "DM_EDITOR_MISSING"
        : "DM_RECIPIENT_UNVERIFIED",
      "刚打开的私信窗口已切换，未输入正文。",
    );
  steps?.complete();
  await startStep("fill_message");
  await page.replaceText(
    input.text,
    'textarea,input[type=text],[contenteditable=true],[contenteditable="plaintext-only"]',
    {
      origin: url.origin,
      signal,
      stillReady: script("focused") + ".ready",
    },
  );
  let draft = await run("draft");
  for (let attempt = 0; !draft.ready && attempt < 6; attempt++) {
    await delay(250, undefined, { signal });
    draft = await run("draft");
  }
  if (!draft.ready)
    throw new PublishingError(
      "DM_DRAFT_UNCONFIRMED",
      "未能在目标会话的输入框中核实私信正文，已停止发送。",
    );
  steps?.complete();
  await startStep("trigger_send");
  await beforeSubmit();
  clock.submittedAt = Date.now();
  const submission = await run("submit");
  const enter =
    !submission.ready && submission.reason === "enter"
      ? await page.pressMessageEnter(
          url.origin,
          signal,
          script("enter") + ".ready",
        )
      : false;
  if (!submission.ready && !enter)
    throw new PublishingError(
      "DM_NOT_DISPATCHED",
      "目标会话内没有可用的发送按钮，或草稿已改变",
    );
  // A stable empty timeline or its last known row anchors the independent history read.
  const stackUnchanged =
    baseline.stackChat &&
    submission.stackChat &&
    baseline.endRow === submission.endRow &&
    baseline.stackMatchCount === submission.stackMatchCount;
  const knownEmpty =
    baseline.stackEmpty && (submission.stackEmpty || submission.stackBlank);
  const weakEmpty = stableBlank && blankList(submission);
  type Snapshot = Awaited<ReturnType<typeof run>>;
  function newStackRow(state: Snapshot) {
    if (
      !stackUnchanged ||
      !state.ready ||
      !state.newestOwn ||
      state.stackMatchCount <= baseline.stackMatchCount
    )
      return "";
    if (
      baseline.endRow &&
      state.previousRow === baseline.endRow &&
      (!state.newestFirst || state.endRow !== baseline.endRow)
    )
      return state.newestOwn;
    return knownEmpty ? state.firstOwn : "";
  }
  function firstAfterBlank(state: Snapshot) {
    return stackUnchanged &&
      weakEmpty &&
      state.ready &&
      !state.stackPreviewConflict
      ? state.firstOwn
      : "";
  }
  const submittedIds = new Set<string>();
  let shownDelivered = false,
    firstShown = "",
    draftStillPresent = false;
  if (!baseline.historyReady) clock.freshSince = clock.submittedAt;
  const previousCount = baseline.historyReady ? baseline.count : 0;
  const previousDelivered = baseline.historyReady ? baseline.delivered : 0;
  const historyAction = input.platform === "douyin" ? "history" : "inspect";
  for (let i = 0; i < 20; i++) {
    const shown = await run(historyAction);
    draftStillPresent = shown.draftStillPresent;
    if (newStackRow(shown)) break;
    if (shown.draftCleared && shown.firstOwnTimeMatches)
      firstShown = firstAfterBlank(shown);
    if (firstShown) break;
    if (shown.count > previousCount) {
      for (const id of shown.messages)
        if (!baseline.messages.includes(id)) submittedIds.add(id);
      shownDelivered = shown.delivered > previousDelivered;
      if (submittedIds.size || shownDelivered) break;
    }
    await delay(250, undefined, { signal });
  }
  steps?.complete();
  await startStep("verify_conversation");
  let confirmed = false,
    reopened = false;
  await observeHistory(freshHistory, async () => {
    const attempts = input.platform === "douyin" ? 2 : 1;
    for (let attempt = 0; attempt < attempts && !confirmed; attempt++) {
      try {
        await openChat(historyAction);
        reopened = true;
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof PublishingError &&
          ["LOGIN_REQUIRED", "DM_CONTACT_RESTRICTED"].includes(error.code)
        )
          break;
        continue;
      }
      for (let i = 0; i < 20; i++) {
        if (
          readBaseline &&
          [...freshHistory].some((id) => !baselineHistory.has(id))
        ) {
          confirmed = true;
          break;
        }
        const result = await run(historyAction);
        const newId = result.messages.some((id) => submittedIds.has(id));
        if (
          newStackRow(result) ||
          (firstShown && firstAfterBlank(result) === firstShown) ||
          (result.ready &&
            result.count > previousCount &&
            (newId || (shownDelivered && result.delivered > previousDelivered)))
        ) {
          confirmed = true;
          break;
        }
        await delay(300, undefined, { signal });
      }
    }
  });
  if (
    confirmed ||
    (readBaseline && [...freshHistory].some((id) => !baselineHistory.has(id)))
  )
    return;
  if (enter === "unobserved")
    throw new PublishingError(
      "DM_OUTCOME_UNKNOWN",
      "应用已触发发送按键，但未观察到抖音输入框收到按键，回查也未核实消息",
    );
  if (draftStillPresent)
    throw new PublishingError(
      "DM_OUTCOME_UNKNOWN",
      "触发发送后，抖音输入框仍保留原草稿，回查也未核实消息",
    );
  if (!reopened)
    throw new PublishingError(
      "DM_OUTCOME_UNKNOWN",
      "已触发发送，重新打开收件人的会话失败，请到平台核对。",
    );
  throw new PublishingError(
    "DM_OUTCOME_UNKNOWN",
    "已触发发送，重新打开目标会话后仍未核实消息，请人工核对",
  );
}
