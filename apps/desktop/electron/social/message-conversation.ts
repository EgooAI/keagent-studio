// This function runs in Electron's isolated world. Keep its DOM helpers inside it.
export function conversation(
  action:
    | "open"
    | "select"
    | "focus"
    | "focused"
    | "draft"
    | "inspect"
    | "history"
    | "receipt"
    | "submit"
    | "enter",
  profile: string,
  text: string,
  sentAfter = 0,
  afterProfileClick = false,
  submittedAt = sentAfter,
) {
  const target = new URL(profile);
  const uid = target.pathname.split("/").pop()!;
  const xhs = target.hostname === "www.xiaohongshu.com";
  const chatPath = "/chat/" + uid;
  const empty = {
    ready: false,
    reason: "editor",
    messages: [] as string[],
    count: 0,
    delivered: 0,
    historyReady: false,
    endRow: "",
    previousRow: "",
    newestFirst: false,
    newestOwn: "",
    stackMatchCount: 0,
    stackChat: false,
    stackEmpty: false,
    stackListReady: false,
    stackBlank: false,
    firstOwn: "",
    firstOwnTimeMatches: false,
    stackPreviewMatches: false,
    stackPreviewConflict: false,
    draftCleared: false,
    draftStillPresent: false,
    receiptTexts: [] as string[],
  };
  const here = location.pathname.replace(/\/$/, "");
  if (location.origin !== target.origin) return { ...empty, reason: "origin" };
  if (/^\/(?:passport|login)(?:\/|$)/.test(here))
    return { ...empty, reason: "login" };
  if (
    (here.startsWith("/user/") && here !== target.pathname) ||
    (xhs && here.startsWith("/chat/") && here !== chatPath)
  )
    return { ...empty, reason: xhs ? "recipient" : "wrong-profile" };
  const visible = (root: ParentNode, selector: string) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
      (el) =>
        el.getClientRects().length &&
        el.ownerDocument.defaultView?.getComputedStyle(el).visibility !==
          "hidden",
    );
  const docs: Document[] = [document];
  for (const doc of docs) {
    for (const el of visible(doc, "iframe")) {
      const frame = (el as HTMLIFrameElement).contentDocument;
      if (frame?.location.origin === target.origin && !docs.includes(frame))
        docs.push(frame);
    }
  }
  const find = (selector: string) =>
    docs.flatMap((doc) => visible(doc, selector));
  const notice = find(
    '[role="alert"],[role="dialog"],[data-e2e="verify-dialog"],[data-e2e="login-modal"],[class*="notice"],[class*="Notice"],[class*="toast"],[class*="Toast"],[class*="chat-tip"],[class*="chatTip"]',
  );
  if (
    notice.some((n) =>
      n.matches('[data-e2e="verify-dialog"],[data-e2e="login-modal"]'),
    )
  )
    return { ...empty, reason: "login" };
  if (
    action !== "history" &&
    action !== "receipt" &&
    notice.some((n) => {
      const label = n.innerText.trim();
      return (
        label.length < 120 &&
        /(?:隐私设置|未互关|未关注|仅接收好友|已关闭私信|不接收陌生人).*(?:无法|不能|不支持|不能再|暂不|拒收)|(?:无法|不能|不支持)向(?:该|对方|此).{0,8}发送(?:消息|私信)|^对方已关闭私信/.test(
          label,
        )
      );
    })
  )
    return { ...empty, reason: "restricted" };

  const controls = 'button,[role="button"],a,span,div[aria-label],div[title]';
  const control = (el: HTMLElement) =>
    el.closest<HTMLElement>('button,[role="button"],a,.send-btn') ?? el;
  const label = (el: HTMLElement) =>
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.innerText?.trim() ||
    "";
  const clickOne = (elements: HTMLElement[]) => {
    const choices = [...new Set(elements)];
    if (
      choices.length !== 1 ||
      choices[0].matches(":disabled,[aria-disabled=true]")
    )
      return empty;
    choices[0].click();
    return { ...empty, ready: true };
  };
  const inbox = '[data-e2e="im-entry"],[data-e2e="message-entry"]';
  // Isolated-world state is scoped to this one document and is discarded on navigation.
  const state = window as Window & {
    keAgentMessageWindow?: {
      profile: string;
      previous: Set<HTMLElement>;
      editor?: HTMLElement;
      panel?: HTMLElement;
      preparedText?: string;
    };
  };
  const stackPage = ".StackLayoutpagespageRoot";
  const stackName = ".StackLayoutStackChatHeadertitle";
  const editSelector =
    'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],input[type="text"]';
  const inViewport = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView;
    return (
      !!view &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < view.innerWidth &&
      rect.top < view.innerHeight
    );
  };
  if (action === "open") {
    if (here !== target.pathname) return empty;
    const profileScope =
      '[data-e2e="user-info"],[data-e2e="user-detail"],[class*="user-info"],[class*="profile-info"]';
    const profileRoots = !xhs ? visible(document, profileScope) : [];
    const candidates = profileRoots.length
      ? profileRoots.flatMap((root) => visible(root, controls))
      : visible(document, controls);
    const matches = candidates
      .filter(
        (el) =>
          /^(私信|发私信|发消息|发送私信)$/.test(label(el)) &&
          (xhs ||
            el.closest(profileScope) ||
            !el.closest('header,[role="banner"],#douyin-header')) &&
          !el.closest(
            inbox +
              ',nav,[role="navigation"],[role="dialog"],aside,[data-e2e="im-dialog"],#imSaasContainerId,article,[role="listitem"]',
          ),
      )
      .map(control);
    const scoped = matches.filter((el) => el.closest(profileScope + ",main"));
    const choices = [...new Set(scoped.length ? scoped : matches)];
    if (!xhs)
      state.keAgentMessageWindow = {
        profile,
        previous: new Set(
          find(editSelector + "," + stackPage).filter(inViewport),
        ),
      };
    const opened = clickOne(choices);
    if (!opened.ready) delete state.keAgentMessageWindow;
    return opened;
  }
  // Only the Xiaohongshu direct-chat and inbox paths use peer metadata.
  const peer = (el: HTMLElement) => {
    const { peerId, peerSecUid } = el.dataset;
    if (peerSecUid && peerId && peerSecUid !== peerId) return "conflict";
    return peerSecUid || peerId;
  };
  const peerLinks = (root: HTMLElement) => {
    const anchors = Array.from(
      root.querySelectorAll<HTMLAnchorElement>("a[href]"),
    );
    if (root.matches("a[href]")) anchors.push(root as HTMLAnchorElement);
    return anchors
      .filter(
        (a) =>
          a.origin === target.origin &&
          a.pathname.startsWith("/user/profile/") &&
          !a.closest(
            'article,blockquote,[role="tooltip"],[class*="profile-card" i],[class*="user-card" i]',
          ),
      )
      .map((a) => a.pathname.replace(/\/$/, ""));
  };
  const rows =
    '[data-e2e*="conversation-item"],[class*="conversation-item"],[class*="conversationItem"],[class*="session-item"],[class*="sessionItem"],[class*="conversation-list"] [role="listitem"],[class*="session-list"] [role="option"]';
  if (action === "select") {
    if (!xhs) return empty;
    const candidates = find(rows).filter((el) => {
      const id = peer(el),
        links = peerLinks(el);
      if ((id && id !== uid) || links.some((p) => p !== target.pathname))
        return false;
      return id === uid || links.includes(target.pathname);
    });
    return clickOne(
      candidates.filter(
        (el) => !candidates.some((child) => child !== el && el.contains(child)),
      ),
    );
  }
  const editors = find(editSelector).filter(
    (el) =>
      !el.matches(
        ':disabled,[readonly],[aria-disabled=true],[role="searchbox"]',
      ) &&
      !el.closest('nav,[role="search"]') &&
      !/搜索/.test(el.getAttribute("placeholder") || ""),
  );
  const headers =
    'header,[role="heading"],[class*="header"],[class*="Header"],[data-e2e*="header"]';
  const chatPanel =
    '[data-e2e="chat-panel"],[class*="chat-panel" i],[class*="chatPanel" i],[class*="conversation-panel" i],[class*="conversationPanel" i]';
  const pane =
    '[role="dialog"],[data-peer-id],[data-peer-sec-uid],' + chatPanel;
  const unrelated =
    'nav,[role="navigation"],[class*="session-list"],[class*="conversation-list"],[class*="message-list" i],[class*="messageList" i],[class*="bubble" i],[data-message-id],[data-direction],blockquote,' +
    rows;
  const contexts: { editor?: HTMLElement; chat: HTMLElement }[] = [];
  const opened = state.keAgentMessageWindow;
  const readingStack = (action === "history" || action === "receipt") && !xhs;
  if (
    readingStack &&
    (opened ? opened.profile === profile : afterProfileClick)
  ) {
    for (const panel of find(stackPage)) {
      if (!inViewport(panel) || opened?.previous.has(panel)) continue;
      const surface = panel.querySelector(
        '.messageMessageListlist,[data-e2e="msg-input"]',
      );
      if (surface?.closest(stackPage) === panel) contexts.push({ chat: panel });
    }
  }
  let sawComposer = false;
  for (const editor of editors) {
    const doc = editor.ownerDocument;
    if (!xhs) {
      if (
        (!opened && !afterProfileClick) ||
        (opened && opened.profile !== profile)
      )
        continue;
      if (
        !inViewport(editor) ||
        opened?.previous.has(editor) ||
        editor.closest(unrelated)
      )
        continue;
      const stack = editor.closest<HTMLElement>(stackPage);
      if (stack && readingStack) continue;
      const chat = stack
        ? editor.closest('[data-e2e="msg-input"]') && stack
        : editor.closest<HTMLElement>(
            chatPanel + ',.chat,[data-e2e="msg-input"]',
          );
      if (chat) contexts.push({ editor, chat });
      continue;
    }
    const idSelector = "[data-peer-id],[data-peer-sec-uid]";
    let marked = editor.closest<HTMLElement>(idSelector);
    while (marked && (!peer(marked) || peer(marked) === uid)) {
      marked = marked.parentElement?.closest<HTMLElement>(idSelector) ?? null;
    }
    if (marked) {
      sawComposer = true;
      continue;
    }
    const onXhsChat = doc.location.pathname.replace(/\/$/, "") === chatPath;
    for (let root = editor.parentElement; root; root = root.parentElement) {
      const id = peer(root);
      if (root === doc.body) {
        if (onXhsChat && editor.matches('[class*="xhs-im-input-bar-editor"]'))
          contexts.push({ editor, chat: root });
        break;
      }
      if (
        !id &&
        !root.matches(
          pane +
            ',[data-e2e*="chat"],[data-e2e*="conversation"],[class*="chat" i],[class*="conversation" i],[class*="dialog" i],[class*="im-panel"]',
        )
      )
        continue;
      // A split view can contain a different recipient's header in a sidebar.
      if (
        root.matches('[class*="layout" i]') ||
        root.querySelector('aside,nav,[role="navigation"]')
      )
        break;
      sawComposer = true;
      const top = visible(root, headers).filter((el) => {
        const owner = el.closest(pane);
        return (
          !el.closest(
            unrelated +
              ',article,[role="tooltip"],[class*="profile-card" i],[class*="user-card" i]',
          ) &&
          (!owner || owner === root || owner.contains(root))
        );
      });
      const heads = top.filter(
        (el) => !top.some((parent) => parent !== el && parent.contains(el)),
      );
      if (heads.length > 1) break;
      const links = heads.flatMap(peerLinks);
      if ((id && id !== uid) || links.some((p) => p !== target.pathname)) break;
      if (
        id === uid ||
        links.includes(target.pathname) ||
        (onXhsChat &&
          (top.length || root.querySelector('[class*="xhs-im-bubble"]')) &&
          root.matches('[class*="chat" i],[class*="conversation" i]'))
      ) {
        contexts.push({ editor, chat: root });
        break;
      }
      if (top.length || root.matches(pane)) break;
    }
  }
  if (contexts.length !== 1)
    return {
      ...empty,
      reason: xhs && (sawComposer || contexts.length) ? "recipient" : "editor",
    };
  const { editor, chat } = contexts[0];
  if (!xhs) {
    // On a new same-origin conversation document the profile click was witnessed by the caller.
    const windowState =
      opened ??
      (state.keAgentMessageWindow = {
        profile,
        previous: new Set<HTMLElement>(),
        editor,
        panel: chat,
      });
    if (
      (windowState.panel && windowState.panel !== chat) ||
      (editor && windowState.editor && windowState.editor !== editor)
    )
      return empty;
    if (editor) windowState.editor = editor;
    windowState.panel = chat;
  }
  let focused = document.activeElement;
  while (focused?.tagName === "IFRAME") {
    const frame = (focused as HTMLIFrameElement).contentDocument;
    if (frame?.location.origin !== target.origin) break;
    focused = frame.activeElement;
  }
  if (action === "focused") return { ...empty, ready: focused === editor };
  const messageText = (value: string) =>
    value.replace(/[\u200b\ufeff\s]+$/u, "").trimStart();
  const editorText = (field: HTMLElement) =>
    messageText(
      field.matches("textarea,input")
        ? (field as HTMLTextAreaElement).value
        : field.innerText,
    );
  if (action === "draft")
    return {
      ...empty,
      ready:
        !!editor && focused === editor && editorText(editor) === text.trim(),
    };
  const outgoing = visible(
    chat,
    '.MessageItemTextisFromMe,[data-direction="out"],[data-is-self="true"],[class*="message-right"],[class*="message-self"],[class*="message--self"],[class*="messageItemSelf"],[class*="bubble--right"],[class*="message-item-me"]',
  );
  const historyReady =
    visible(
      chat,
      '[role="log"][aria-busy="false"],[data-history-loaded="true"]',
    ).length > 0;
  const isFresh = (el: HTMLElement) => {
    if (!sentAfter) return true;
    const row =
      el.closest<HTMLElement>("[data-created-at],[data-timestamp]") ?? el;
    const raw =
      row.dataset.createdAt ||
      row.dataset.timestamp ||
      el.querySelector("time[datetime]")?.getAttribute("datetime");
    if (!raw) return false;
    const stamp = /^\d{10}$/.test(raw)
      ? Number(raw) * 1000
      : /^\d{13}$/.test(raw)
        ? Number(raw)
        : Date.parse(raw);
    return stamp >= sentAfter && stamp <= Date.now() + 30_000;
  };
  const deliveryStatus = '[class*="status" i],[data-e2e="message-status"]';
  const unsentStatus =
    '[data-status="failed"],[data-status="sending"],[data-status="pending"],[aria-label="发送失败"],[title="发送失败"],[class*="sendFail" i],[class*="sendError" i]';
  const isUnsent = (el: HTMLElement) =>
    !!el.closest(unsentStatus) ||
    !!el.querySelector(unsentStatus) ||
    visible(el, deliveryStatus).some((s) =>
      /^(发送失败|发送中|待发送|未发送)$/.test(s.innerText.trim()),
    );
  const bubbles = outgoing.filter(
    (el) =>
      isFresh(el) &&
      !isUnsent(el) &&
      (messageText(el.innerText) === text.trim() ||
        visible(
          el,
          '.TextMessageTextpureText,.xhs-im-bubble__text,[class*="bubble-text"],[data-e2e="message-text"]',
        ).some((n) => messageText(n.innerText) === text.trim())),
  );
  const ids = bubbles
    .map((el) => {
      const row =
        el.closest<HTMLElement>(
          "[data-server-message-id],[data-message-id],[data-msg-id]",
        ) ?? el;
      return (
        row.dataset.serverMessageId ||
        row.dataset.messageId ||
        row.dataset.msgId ||
        ""
      );
    })
    .filter(Boolean);
  const delivered = bubbles.filter(
    (el) =>
      el.matches('[data-status="delivered"],[data-status="read"]') ||
      visible(el, deliveryStatus).some((s) =>
        /^(已送达|已读)$/.test(s.innerText.trim()),
      ),
  ).length;
  // Douyin can number the bottom (newest) bubble zero and renumber existing rows on insertion.
  const stackChat = chat.matches(stackPage);
  const stackLists = stackChat ? visible(chat, ".messageMessageListlist") : [];
  const stackIdle =
    stackChat &&
    !visible(
      chat,
      '[aria-busy="true"],[role="progressbar"],[class*="loading" i],[data-e2e="load-error"]',
    ).length;
  const noStackRows =
    stackIdle &&
    !chat.querySelector(
      '.messageMessageListlist [data-index],[data-e2e="msg-item-content"]',
    );
  const stackListReady = stackIdle && stackLists.length === 1;
  const stackBlank = stackListReady && noStackRows;
  const items =
    stackLists.length === 1
      ? visible(stackLists[0], "[data-index]").sort(
          (a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top,
        )
      : [];
  // A relative label describes a time interval. Only the label inside this message's row counts.
  const rowTime = (row: HTMLElement) => {
    if (!submittedAt) return "unknown";
    const timed = row.matches("[data-created-at],[data-timestamp]")
      ? row
      : row.querySelector<HTMLElement>("[data-created-at],[data-timestamp]");
    const raw =
      timed?.dataset.createdAt ||
      timed?.dataset.timestamp ||
      row.querySelector("time[datetime]")?.getAttribute("datetime");
    const now = Date.now();
    if (raw) {
      const seconds = /^\d{10}$/.test(raw);
      const stamp = seconds
        ? Number(raw) * 1000
        : /^\d{13}$/.test(raw)
          ? Number(raw)
          : Date.parse(raw);
      if (!Number.isFinite(stamp)) return "unknown";
      const precision =
        seconds || /T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)
          ? 999
          : 0;
      if (stamp + precision < submittedAt || stamp > now + 30_000)
        return "outside";
      return stamp <= submittedAt + 30_000 ? "matches" : "unknown";
    }
    const labels = visible(row, ".MessageBoxTimetimeLayout").filter(
      (el) => el.closest("[data-index]") === row,
    );
    if (labels.length !== 1) return "unknown";
    const label = labels[0].innerText.trim();
    // Douyin keeps “刚刚” for several minutes. It cannot date a historical send by itself.
    if (label === "刚刚" && action === "receipt") return "unknown";
    const hhmm = /^(?:(今天|昨天)\s*)?([01]?\d|2[0-3]):([0-5]\d)$/.exec(label);
    if (hhmm) {
      const start = new Date(now);
      if (hhmm[1] === "昨天") start.setDate(start.getDate() - 1);
      start.setHours(Number(hhmm[2]), Number(hhmm[3]), 0, 0);
      const stamp = start.getTime();
      if (stamp + 60_000 <= submittedAt || stamp > now) return "outside";
      return stamp <= submittedAt + 30_000 ? "matches" : "unknown";
    }
    const minutes =
      label === "刚刚" ? 0 : Number(label.match(/^(\d+)\s*分钟前$/)?.[1]);
    if (!Number.isFinite(minutes)) return "unknown";
    const upper = now - minutes * 60_000;
    if (upper < submittedAt) return "outside";
    return upper - 60_000 <= submittedAt + 30_000 ? "matches" : "unknown";
  };
  const rowDetail = (row: HTMLElement) => {
    const bodies = visible(
      row,
      '[data-e2e="msg-item-content"] .TextMessageTextpureText,.messageMessageBoxisFullRowCenterMessage .SystemNormalSystemcontainer',
    );
    if (bodies.length !== 1 || !/^\d+$/.test(row.dataset.index ?? "")) return;
    const body = bodies[0];
    const direction = body.matches(".SystemNormalSystemcontainer")
      ? "system"
      : body.closest(".MessageItemTextisFromMe")
        ? "out"
        : "in";
    const value = messageText(body.innerText);
    if (!value || isUnsent(row)) return;
    const index = Number(row.dataset.index);
    return {
      index,
      direction,
      value,
      key: JSON.stringify([index, direction, value]),
      time: rowTime(row),
    };
  };
  const details = items.map(rowDetail);
  const outgoingRows = details.filter((item) => item?.direction === "out");
  const receiptTexts =
    action === "receipt" && stackListReady
      ? outgoingRows
          .filter(
            (item) =>
              item?.time === "matches" &&
              !outgoingRows.some(
                (other) =>
                  other !== item &&
                  other?.value === item.value &&
                  other.time !== "outside",
              ),
          )
          .map((item) => item!.value)
      : [];
  const tail = details.at(-1);
  const position = details
    .map(
      (item) =>
        item?.direction === "out" &&
        item.value === text.trim() &&
        item.time !== "outside",
    )
    .lastIndexOf(true);
  const latest = details[position],
    previous = details[position - 1];
  const stackMatchCount = details.filter(
    (item) => item?.direction === "out" && item.value === text.trim(),
  ).length;
  const firstOwn = latest?.index === 0 && position === 0 ? latest.key : "";
  let stackEmpty =
      stackBlank &&
      (historyReady ||
        visible(
          chat,
          '[data-e2e*="empty"],[class*="empty" i],[role="status"]',
        ).some((el) =>
          /^(暂无消息|暂无聊天记录|还没有聊天记录)$/.test(el.innerText.trim()),
        )),
    stackPreviewConflict = false,
    stackPreviewMatches = false;
  const inboxContainer =
    stackChat && chat.closest<HTMLElement>("#imSaasContainerId");
  // Only the history receipt needs the conversation's preview. It never determines who to open or send to.
  const threadTitle = stackChat
    ? visible(chat, stackName)[0]?.innerText.trim()
    : "";
  if (inboxContainer && threadTitle) {
    const peers = visible(
      inboxContainer,
      '.conversationConversationListwrapper .conversationConversationItemwrapper[data-e2e="conversation-item"]',
    ).filter((row) => {
      const names = visible(row, ".conversationConversationItemtitle");
      return (
        !chat.contains(row) &&
        names.length === 1 &&
        names[0].innerText.trim() === threadTitle
      );
    });
    if (peers.length === 1) {
      const previews = visible(peers[0], "pre.ConversationItemHinttextBox");
      if (previews.length === 1) {
        const preview = messageText(previews[0].innerText);
        const greeting = "和“" + threadTitle + "”打个招呼吧";
        stackPreviewMatches = preview === text.trim() && preview !== greeting;
        const excerpt = preview.replace(/(?:…+|\.{3})$/, "");
        stackPreviewConflict =
          !!preview &&
          preview !== greeting &&
          !stackPreviewMatches &&
          (!latest || position === details.length - 1) &&
          !text.trim().startsWith(excerpt);
        if (preview === greeting && text.trim() !== greeting && noStackRows)
          stackEmpty = true;
      }
    }
  }
  const preparedEditor =
    opened?.preparedText === text &&
    opened.editor &&
    chat.contains(opened.editor) &&
    inViewport(opened.editor)
      ? opened.editor
      : undefined;
  const snapshot = {
    ready: true,
    reason: "",
    messages: ids,
    count: bubbles.length,
    delivered,
    historyReady,
    endRow: tail?.key ?? "",
    previousRow:
      previous && latest?.index === previous.index + 1
        ? previous.key
        : previous &&
            latest &&
            previous.index === latest.index + 1 &&
            tail?.index === 0
          ? JSON.stringify([0, previous.direction, previous.value])
          : "",
    newestFirst: !!previous && !!latest && previous.index === latest.index + 1,
    newestOwn: latest?.key ?? "",
    stackMatchCount,
    receiptTexts,
    stackChat,
    stackEmpty,
    stackListReady,
    stackBlank,
    firstOwn,
    firstOwnTimeMatches: !!firstOwn && latest?.time === "matches",
    stackPreviewMatches,
    stackPreviewConflict,
    draftCleared: !!preparedEditor && !editorText(preparedEditor),
    draftStillPresent:
      !!preparedEditor && editorText(preparedEditor) === text.trim(),
  };
  if (action === "focus") editor?.focus();
  if (action === "submit" || action === "enter") {
    if (!editor) return empty;
    if (focused !== editor || editorText(editor) !== text.trim()) return empty;
    const sendControl = '.send-btn,[class*="input-bar"] [class*="send"]';
    if (stackChat) {
      const composer = editor.closest<HTMLElement>('[data-e2e="msg-input"]')!;
      const available = visible(composer, "svg.e2e-send-msg-btn");
      if (
        available.length !== 1 ||
        available[0].closest(':disabled,[aria-disabled="true"]')
      )
        return { ...empty, reason: "button" };
      if (action === "enter" && opened) opened.preparedText = text;
      // Electron delivers one trusted Enter only after rechecking this exact focused draft.
      return { ...snapshot, ready: action === "enter", reason: "enter" };
    }
    const sends = visible(chat, controls + "," + sendControl).filter(
      (el) => label(el) === "发送" || el.matches(sendControl),
    );
    if (!sends.length) {
      const enterLabel = (v: string) =>
        v
          .split(/[，。,:：；;]/)
          .some((part) =>
            /^(?:按\s*)?(?:Enter|回车)(?:\s*键)?\s*发送(?:消息)?$/i.test(
              part.trim(),
            ),
          );
      const enterHint =
        editor.getAttribute("enterkeyhint") === "send" ||
        enterLabel(
          editor.getAttribute("placeholder") ??
            editor.dataset.placeholder ??
            "",
        ) ||
        visible(chat, 'small,[class*="hint" i],[class*="tip" i]').some((el) =>
          enterLabel(el.innerText.trim()),
        );
      return {
        ...empty,
        ready: action === "enter" && enterHint,
        reason: enterHint ? "enter" : "button",
      };
    }
    if (action === "enter") return empty;
    if (!clickOne(sends.map(control)).ready) return empty;
  }
  return snapshot;
}
