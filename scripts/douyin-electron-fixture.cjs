// All platform domains below are intercepted inside dedicated test Sessions. No real publishing.
const { app, BrowserWindow, protocol } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const root =
  process.env.DOUYIN_TEST_ROOT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "keagent-douyin-electron-"));
app.setPath("userData", root);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "keagent",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const failVideo = process.env.DOUYIN_TEST_UPLOAD_FAILURE === "1";
const failCover = process.env.DOUYIN_TEST_COVER_FAILURE === "1";
const directCover = process.env.DOUYIN_TEST_DIRECT_COVER === "1";
const scheduleTest = process.env.DOUYIN_TEST_SCHEDULE;
const scheduledAt = scheduleTest
  ? Math.ceil((Date.now() / 1000 + 86400) / 60) * 60
  : undefined;
async function verifyCommentSync(
  testAPI,
  workId,
  accountId,
  ownerId,
  deviceId,
) {
  const scope = { workId, accountId };
  const request = (operation, data = {}) =>
    testAPI("/v1/collection/comments/" + operation, { ...scope, ...data });
  const sync = (requestKey = crypto.randomUUID()) =>
    request("sync", { requestKey });
  assert.equal((await request("list")).sourceState, "unconfigured");
  await assert.rejects(sync(), { code: "COMMENT_SOURCE_UNCONFIGURED" });
  // The Go integration runner creates these files inside t.TempDir().
  const grantFile = process.env.COMMENT_FIXTURE_GRANT;
  assert.ok(grantFile && grantFile === process.env.KEAGENT_COMMENT_GRANTS_FILE);
  const grant = {
    ...scope,
    ownerId,
    deviceId,
    ref: "test-export",
    label: "合成测试导出",
    kind: "export",
    exportFile: "test-comments.json",
    retentionDays: 2,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    manualContact: true,
    fields: [
      "comment_id",
      "parent_comment_id",
      "comment_text",
      "commenter_name",
      "commenter_profile",
      "like_count",
    ],
  };
  const snapshot = {
    ...scope,
    ownerId,
    deviceId,
    sourceRef: grant.ref,
    snapshotId: "sample-a",
    observedAt: new Date(Date.now() - 10000).toISOString(),
    coverage: "partial",
    items: [
      {
        comment_id: "p1",
        commenter_name: "测试角色",
        comment_text: "附近有整租的一居室吗？",
        commenter_profile: "https://www.douyin.com/user/fixture-actor",
        like_count: 0,
      },
      { comment_id: "r1", parent_comment_id: "p1", comment_text: "合成回复" },
    ],
  };
  const writeSnapshot = () =>
    fs.writeFileSync(
      path.join(path.dirname(grantFile), grant.exportFile),
      JSON.stringify(snapshot),
    );
  writeSnapshot();
  fs.writeFileSync(grantFile, JSON.stringify([grant]));
  const requestKey = crypto.randomUUID();
  const first = await sync(requestKey);
  assert.equal(first.addedCount, 2);
  assert.deepEqual(await sync(requestKey), first);
  const page = await request("list");
  assert.equal(page.coverage, "partial");
  assert.equal(page.canAnalyze, false);
  assert.equal(page.canContact, true);
  assert.equal(page.items.length, 2);
  const parent = page.items.find((row) => row.comment_id === "p1");
  assert.equal(parent.like_count, 0);
  assert.equal(parent.commenter_name, "测试角色");
  assert.equal(parent.reply_count, null);
  assert.equal(
    page.items.find((row) => row.comment_id === "r1").parent_comment_id,
    "p1",
  );
  assert.deepEqual(await request("contact", { id: parent.id }), {
    profileUrl: snapshot.items[0].commenter_profile,
  });
  await assert.rejects(request("analyze", { id: parent.id }), { status: 403 });
  snapshot.snapshotId = "sample-b";
  snapshot.observedAt = new Date().toISOString();
  snapshot.items[0].like_count = 3;
  writeSnapshot();
  const update = await sync();
  assert.equal(update.addedCount, 0);
  assert.equal(update.updatedCount, 1);
  assert.equal((await request("get", { id: parent.id })).like_count, 3);
  fs.writeFileSync(grantFile, JSON.stringify([{ ...grant, revoked: true }]));
  assert.deepEqual((await request("list")).items, []);
  assert.equal((await request("list")).sourceState, "revoked");
  await assert.rejects(request("contact", { id: parent.id }), { status: 403 });
  console.log("Comment detail shared API passed.");
}
function creatorForm(videoHash, coverHash) {
  return `<!doctype html><meta charset="utf-8"><style>
    [contenteditable] { min-height: 40px; white-space: pre-wrap; }
    #settings { margin-top: 1200px; }
    .cover-fixture { width: 120px; height: 90px; background: #ddd; }
    #cover-editor { position: fixed; inset: 25% 30%; z-index: 2; background: white; }
    #cover-upload { display: block; height: 42px; }
    .bg-fixture { width: 90px; height: 60px; background-size: cover; }
    label { position: relative; display: inline-block; padding: 8px; }
    label input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; margin: 0; }
    label span { pointer-events: none; }
  </style>
  <button id="upload">上传视频</button><input id="video" type="file" hidden>
  <section id="form" hidden>
    <div id="uploadStatus">取消上传</div>
    <input id="title" placeholder="填写作品标题，为作品获得更多流量">
    <div id="caption" contenteditable="true" data-placeholder="添加作品简介"></div>
    <div class="coverControl-fixture"><div class="cover-fixture" id="horizontal"></div><div class="cover-tip-fixture">横封面4:3</div></div>
    <div class="coverControl-fixture"><div class="cover-fixture" id="vertical"><img id="applied-preview" width="90"></div><div class="cover-tip-fixture">竖封面3:4</div></div>
    <div id="cover-editor" class="${directCover ? "direct-cover-fixture" : "coverSelect-fixture"}" hidden>
      ${
        directCover
          ? `
      <div><div id="file-preview" class="bg-fixture"></div>
        <div class="upload-tips-fixture"><div>上传封面</div></div>
        <div class="upload-fixture">
          <input id="cover" class="semi-upload-hidden-input" type="file" accept="image/jpeg,image/png" hidden>
          <input class="semi-upload-hidden-input-replace" type="file" accept="image/jpeg,image/png" hidden>
        </div>
      </div>
      <button id="confirm-cover">完成</button>
      <button id="skip-horizontal" hidden>暂不设置</button>
      `
          : `
      <div id="cover-tab">上传封面</div>
      <div id="cover-area" hidden><span id="cover-upload">点击上传 或直接将图片文件拖入此区域</span></div>
      <input id="cover" type="file" accept="image/jpeg,image/png" hidden>
      <div class="uploadCrop-fixture" id="crop" hidden><button id="confirm-cover">完成</button></div>
      `
      }
    </div>
    <div id="cover-result" role="status"></div>
    <section id="settings">
    <label><input type="radio" name="sync" checked value="同时发布"><span>同时发布</span></label>
    <label><input type="radio" name="sync" value="不同时发布"><span>不同时发布</span></label>
    <label><input type="radio" name="visibility" checked value="公开"><span>公开</span></label>
    <label><input type="radio" name="download" checked value="允许"><span>允许</span></label>
    <label><input type="radio" name="download" value="不允许"><span>不允许</span></label>
    <label><input type="radio" name="schedule" checked value="立即发布"><span>立即发布</span></label>
    <label><input id="schedule" type="radio" name="schedule" value="定时发布"><span>定时发布</span></label>
    <input id="schedule-date" placeholder="日期和时间" hidden>
    <button id="submit" disabled>发布</button>
    </section>
  </section>
  <script>
    const el = id => document.getElementById(id);
    const digest = async file => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
    let video, caption, selectedCover, appliedCover, imageURL, skipClicks = 0;
    let uploaded = false;
    el('schedule').onchange = () => { el('schedule-date').hidden = !el('schedule').checked; };
    el('schedule-date').oninput = () => {
      if (${scheduleTest === "readback_mismatch"}) el('schedule-date').value = '2099-01-01 10:00';
    };
    el('upload').onclick = () => el('video').click();
    el('horizontal').onclick = () => { throw new Error('Wrong cover ratio'); };
    el('vertical').onclick = () => { el('cover-editor').hidden = false; };
    if (!${directCover}) {
      el('cover-tab').onclick = () => { el('cover-area').hidden = false; };
      el('cover-upload').onclick = () => el('cover').click();
    }
    el('cover').onchange = async () => {
      selectedCover = await digest(el('cover').files[0]);
      if (selectedCover !== ${JSON.stringify(coverHash)}) return;
      if (${directCover}) {
        imageURL = URL.createObjectURL(el('cover').files[0]);
        el('file-preview').style.backgroundImage = 'url(' + imageURL + ')';
      } else {
        el('cover-area').hidden = true;
        el('crop').hidden = false;
      }
    };
    const saveCover = () => {
      setTimeout(() => {
        if (${failCover}) {
          el('cover-result').textContent = '封面上传失败，请重试';
          return;
        }
        appliedCover = selectedCover;
        el('cover-editor').hidden = true;
        if (${directCover}) el('applied-preview').src = imageURL;
        else el('cover-result').textContent = '封面上传成功';
      }, 600);
    };
    if (${directCover}) el('skip-horizontal').onclick = () => {
      if (++skipClicks === 1) saveCover();
    };
    el('confirm-cover').onclick = () => {
      el('confirm-cover').disabled = true;
      if (${directCover}) el('skip-horizontal').hidden = false;
      else saveCover();
    };
    el('video').onchange = async () => {
      video = await digest(el('video').files[0]);
      if (video !== ${JSON.stringify(videoHash)}) return;
      el('upload').hidden = true;
      el('form').hidden = false;
      setTimeout(() => {
        uploaded = ${!failVideo};
        el('uploadStatus').textContent = uploaded ? '重新上传' : '上传失败，重新上传';
        el('submit').disabled = !uploaded;
      }, 600);
    };
    el('title').oninput = () => { if (!uploaded) el('title').value = ''; };
    el('caption').onbeforeinput = event => {
      if (!uploaded) return;
      event.preventDefault();
      if (!event.isTrusted || typeof event.data !== 'string') return;
      caption = event.data;
      // The editor can render a different string from the one it submits.
      el('caption').textContent = caption.replaceAll('\\n', '');
    };
    el('submit').onclick = async () => {
      el('submit').disabled = true;
      if (${directCover} && skipClicks !== 1) throw new Error('Cover confirmation must be clicked once');
      const response = await fetch('/web/api/media/aweme/create_v2/?read_aid=2906', {
        method: 'POST',
        body: JSON.stringify({
          video, cover: appliedCover, title: el('title').value,
          caption,
          ...(el('schedule').checked ? { item: { common: {
            timing: ${scheduleTest === "request_mismatch"} ? 0 : Date.parse(el('schedule-date').value.replace(' ', 'T') + '+08:00') / 1000
          } } } : {}),
          settings: Array.from(document.querySelectorAll('input:checked'), input => input.value),
        }),
      });
      if ((await response.json()).item_id)
        history.pushState(null, '', '/creator-micro/content/manage?enter_from=publish');
    };
  </script>`;
}
app.whenReady().then(async () => {
  const windows = [];
  try {
    const project = path.resolve(__dirname, "..");
    const { registerArtifactMedia } = require(
      path.join(
        project,
        "apps/desktop/electron/artifact-media/dist/runtime.cjs",
      ),
    );
    const { registerPublishing } = require(
      path.join(project, "apps/desktop/electron/publishing/dist/runtime.cjs"),
    );
    protocol.handle(
      "keagent",
      () =>
        new Response(
          "<!doctype html><html><body><h1>Controlled integration surface</h1></body></html>",
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(project, "apps/desktop/electron/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.push(window);
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(
          project,
          "packages/shared-types/fixtures/artifact-handoff.v1.json",
        ),
        "utf8",
      ),
    );
    const video = fs.readFileSync(
      path.join(project, "apps/desktop/public/media/demo-property.mp4"),
    );
    const cover = fs.readFileSync(
      path.join(project, "apps/desktop/public/media/interior-1.jpg"),
    );
    const controlledVideo = path.join(root, "test-video.mp4"),
      controlledCover = path.join(root, "test-cover.jpg");
    fs.writeFileSync(controlledVideo, video);
    fs.writeFileSync(controlledCover, cover);
    for (const asset of fixture.assets) {
      const bytes = asset.kind === "video" ? video : cover;
      asset.byteSize = bytes.length;
      asset.sha256 = hash(bytes);
    }
    const accounts = new Map(),
      records = new Map(),
      requests = [];
    let submits = 0;
    let dropTerminal = true;
    let dropLeaseRenewal = false;
    const sessions = [];
    const commentImports = [];
    const noteId = "67b32410000000001100aaaa";
    const xhsUserId = "61b32410000000001100aaaa";
    let contactProfile = "https://www.douyin.com/user/fixture-commenter";
    let contactAccountMarker = "controlled-public-id";
    let contactChecks = 0;
    let generation = 1;
    const testBase = process.env.ARTIFACT_EXCHANGE_TEST_URL;
    async function testAPI(route, input) {
      assert.ok(
        testBase &&
          new URL(testBase).hostname === "127.0.0.1" &&
          new URL(testBase).protocol === "http:",
      );
      const body = JSON.stringify(input);
      const actor = {
        userId: fixture.ownerId,
        deviceId: fixture.deviceId,
        sessionId: "registry-integration-session",
        role: "admin",
        timestamp: Math.floor(Date.now() / 1000),
        nonce: crypto.randomBytes(16).toString("hex"),
      };
      const encoded = Buffer.from(JSON.stringify(actor)).toString("base64url");
      const signature = crypto
        .createHmac("sha256", process.env.ARTIFACT_EXCHANGE_TEST_SECRET)
        .update(`POST\n${route}\n${encoded}\n${hash(Buffer.from(body))}`)
        .digest("hex");
      const response = await fetch(testBase + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Keagent-Context": encoded,
          "X-Keagent-Signature": signature,
        },
        body,
      });
      const value = await response.json();
      if (!response.ok)
        throw Object.assign(
          new Error(value.error?.message || "Integration API failed"),
          { status: response.status, code: value.error?.code },
        );
      return value;
    }
    const dependencies = {
      identity: async () => ({
        userId: fixture.ownerId,
        deviceId: fixture.deviceId,
        generation,
      }),
      exchange: {
        getHandoff: async () => structuredClone(fixture),
        getArtifact: async () => structuredClone(fixture.artifact),
        getAsset: async (id) =>
          structuredClone(fixture.assets.find((asset) => asset.id === id)),
      },
      request: async (route, input = {}) => {
        if (route === "/v1/collection/lead/consent/save")
          return { state: "active" };
        if (route === "/v1/collection/comments/import") {
          commentImports.push(input);
          return {
            readCount: input.items.length,
            addedCount: input.items.length,
            updatedCount: 0,
            coverage: input.coverage,
          };
        }
        if (route === "/v1/collection/comments/contact") {
          assert.deepEqual(input, {
            accountId: [...accounts.keys()][0],
            workId: "10001",
            id: "3".repeat(32),
          });
          contactChecks++;
          return { profileUrl: contactProfile };
        }
        const op = route.replace("/v1/douyin/", "");
        if (op === "accounts/list") return { items: [...accounts.values()] };
        if (op === "accounts/bind" || op === "accounts/update") {
          const account = {
            ...accounts.get(input.id),
            ...input,
            deviceId: fixture.deviceId,
            lastCheckedAt: new Date().toISOString(),
          };
          accounts.set(input.id, account);
          return account;
        }
        if (op === "records/create") {
          const prior = records.get(input.requestKey);
          if (prior) return { record: prior, created: false };
          const record = {
            ...input,
            id: "e".repeat(32),
            ownerId: fixture.ownerId,
            deviceId: fixture.deviceId,
            artifactId: fixture.artifact.id,
            state: "running",
            progress: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            logs: [],
          };
          records.set(input.requestKey, structuredClone(record));
          return { record, created: true };
        }
        if (op === "records/report") {
          if (input.state === "accepted" && dropTerminal) {
            dropTerminal = false;
            throw new Error("Controlled lost terminal acknowledgment");
          }
          records.set(input.requestKey, structuredClone(input));
          return structuredClone(input);
        }
        if (op === "records/heartbeat") return {};
        throw new Error("Unexpected controlled cloud operation");
      },
      configureSession: async (session) => {
        sessions.push(session);
        await session.cookies.set({
          url: "https://creator.douyin.com/",
          name: "sessionid",
          domain: ".douyin.com",
          value: "explicit-test-cookie",
          expirationDate: Date.now() / 1000 + 3600,
        });
        await session.cookies.set({
          url: "https://www.xiaohongshu.com/",
          name: "web_session",
          value: "xhs-fixture-session",
          expirationDate: Date.now() / 1000 + 3600,
        });
        session.protocol.handle("https", async (request) => {
          const url = new URL(request.url);
          requests.push(url.pathname + url.search);
          const json = (value) =>
            new Response(JSON.stringify(value), {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://creator.douyin.com",
                "Access-Control-Allow-Credentials": "true",
              },
            });
          const html = (body) =>
            new Response(body, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          if (
            url.hostname === "www.douyin.com" &&
            url.pathname === "/video/12345"
          )
            return html(`<div data-e2e="comment-list" style="height:90px;width:300px;overflow:auto"><p style="height:500px">分页夹具</p></div>
            <script>
            fetch('/aweme/v1/web/comment/list/?aweme_id=99999&cursor=0');
            fetch('/aweme/v1/web/comment/list/?aweme_id=12345&cursor=0');
            document.querySelector('div').addEventListener('scroll', () => fetch('/aweme/v1/web/comment/list/?aweme_id=12345&cursor=20'),{once:true});
            </script>`);
          if (
            url.hostname === "www.douyin.com" &&
            url.pathname === "/aweme/v1/web/comment/list/"
          ) {
            assert.equal(
              session,
              sessions[0],
              "Douyin responses must come from the chosen saved Profile",
            );
            const work = url.searchParams.get("aweme_id");
            const last = url.searchParams.get("cursor") === "20";
            const row = (id) => ({
              cid: id,
              aweme_id: work,
              text: "抖音-" + id,
              user: { sec_uid: "fixture-user", nickname: "评论者" },
            });
            return json({
              status_code: 0,
              comments: last
                ? [row("first"), row("second")]
                : [row(work === "12345" ? "first" : "other-work")],
              has_more: last ? 0 : 1,
            });
          }
          if (url.hostname === "www.xiaohongshu.com") {
            if (url.pathname === "/explore")
              return html(
                `<nav><a href="/user/profile/${xhsUserId}">我</a></nav>`,
              );
            if (url.pathname === "/explore/" + noteId)
              return html(`<section class="comments-container">小红书</section><script>
                window.__INITIAL_STATE__={note:{noteDetailMap:{${JSON.stringify(noteId)}:{comments:{list:[{id:'ssr',noteId:${JSON.stringify(noteId)},content:'首屏',userInfo:{userId:${JSON.stringify(xhsUserId)}}}]}}}}};
                fetch('/api/sns/web/v2/comment/page?note_id=${noteId}&cursor=0');
                </script>`);
            if (url.pathname === "/api/sns/web/v2/comment/page") {
              assert.notEqual(
                session,
                sessions[0],
                "XHS uses its own saved Profile",
              );
              return json({
                code: 0,
                success: true,
                data: {
                  comments: [
                    {
                      id: "page",
                      note_id: noteId,
                      content: "小红书分页",
                      user_info: { user_id: xhsUserId },
                    },
                  ],
                  has_more: false,
                },
              });
            }
          }
          if (url.hostname === "www.douyin.com") {
            const id = url.pathname.split("/").pop();
            const rootId = id === "10007" ? "99999" : id;
            const html =
              id === "10003"
                ? '<input placeholder="手机号">'
                : id === "10004"
                  ? '<button class="captcha">安全验证</button>'
                  : id === "10005"
                    ? '<script>location.replace("/video/10008")</script>'
                    : ["10013", "10014", "10015"].includes(id)
                      ? `<title>夹具作品 - 抖音</title><link rel="canonical" href="https://www.douyin.com/video/${id}">
                         <article data-e2e="video-detail">
                          <section data-e2e="detail-video-info"><h1>${id === "10014" ? "其他作品" : "夹具作品"}</h1></section>
                          <aside data-e2e="related-video"><section data-e2e="user-info">
                           <a href="/user/${id === "10015" ? "other" : "author"}"><img alt="作者头像" width="24" height="24"></a>
                           <a href="/user/author">夹具作者</a></section></aside>
                          <section data-e2e="comment-list">评论</section>
                         </article>`
                      : id === "10006"
                        ? '<script>location.replace("/recommend")</script>'
                        : `<header>作品详情</header>
               <article data-e2e="video-detail" data-aweme-id="${rootId}">
                 <a data-e2e="video-author-name" href="${id === "10009" ? "/recommend" : "/user/test-author"}">其他作者</a>
                 <p data-e2e="video-desc">目标作品</p>
                 ${
                   id === "10010"
                     ? '<section data-e2e="comment-list"><span data-e2e="comment-loading">加载中</span></section>'
                     : id === "10011"
                       ? '<section data-e2e="comment-list"><span data-e2e="comment-load-error">加载失败</span></section>'
                       : id === "10012"
                         ? '<section data-aweme-id="99999" data-e2e="comment-list">评论</section>'
                         : id === "10002"
                           ? '<section hidden data-e2e="comment-list"></section>'
                           : '<section data-e2e="comment-list">' +
                             (id === "10001"
                               ? '<span data-e2e="comment-empty">暂无评论</span>'
                               : '<p data-e2e="comment-item">PRIVATE COMMENT FIXTURE</p>') +
                             "</section>"
                 }
               </article>`;
            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          if (url.pathname.includes("user/info"))
            return json({
              status_code: 0,
              douyin_user_verify_info: {
                douyin_unique_id: "controlled-public-id",
                nick_name: "集成测试抖音账号",
              },
            });
          if (url.pathname === "/creator-micro/content/upload")
            return new Response(creatorForm(hash(video), hash(cover)), {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          if (url.pathname === "/web/api/media/aweme/create_v2/") {
            submits++;
            assert.equal(request.method, "POST");
            const submission = await request.json();
            assert.deepEqual(submission, {
              video: hash(video),
              cover: hash(cover),
              title: "集成测试视频",
              caption: "仅测试适配器\n\n后续一段 #测试",
              ...(scheduledAt
                ? { item: { common: { timing: scheduledAt } } }
                : {}),
              settings: [
                "不同时发布",
                "公开",
                "不允许",
                scheduledAt ? "定时发布" : "立即发布",
              ],
            });
            assert.equal(
              records.get("electron-publish-fixture-0001")?.state,
              "submitting",
            );
            return new Response(
              '{"status_code":0,"item_id":7612345678901234567}',
              { headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.hostname !== "creator.douyin.com")
            throw new Error("Unexpected fixture host");
          return new Response(
            '<!doctype html><html><body><div class="avatar"><img alt="avatar"></div><p>抖音号：' +
              contactAccountMarker +
              '</p><a href="/creator-micro/content/manage">内容管理</a></body></html>',
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        });
      },
    };
    if (testBase) {
      dependencies.exchange.getAsset = (id) =>
        testAPI("/v1/media-assets/get", { id });
      dependencies.exchange.getArtifact = (id) =>
        testAPI("/v1/artifacts/get", { id });
      dependencies.exchange.getHandoff = (id) =>
        testAPI("/v1/artifact-handoffs/get", { id });
      dependencies.request = async (route, input) => {
        if (dropLeaseRenewal && route === "/v1/collection/runs/heartbeat")
          throw new Error("Controlled offline lease renewal");
        if (
          route.endsWith("records/report") &&
          input.state === "accepted" &&
          dropTerminal
        ) {
          dropTerminal = false;
          throw new Error("Controlled lost terminal acknowledgment");
        }
        const value = await testAPI(route, input);
        if (route.endsWith("records/create"))
          records.set(input.requestKey, structuredClone(value.record));
        if (route.endsWith("records/report"))
          records.set(input.requestKey, structuredClone(value));
        return value;
      };
    }
    const assetRequests = new Map();
    dependencies.exchange.registerAsset = async (input) => {
      if (assetRequests.has(input.requestKey))
        return structuredClone(assetRequests.get(input.requestKey));
      const index = input.kind === "video" ? 0 : 1;
      const { requestKey, fileToken, ...metadata } = input;
      const asset = {
        ...fixture.assets[index],
        ...metadata,
        location: { kind: "local", deviceId: fixture.deviceId, fileToken },
      };
      if (testBase)
        Object.assign(asset, await testAPI("/v1/media-assets/register", input));
      fixture.assets[index] = asset;
      assetRequests.set(requestKey, asset);
      return structuredClone(asset);
    };
    dependencies.exchange.createArtifact = async (input) => {
      fixture.artifact = {
        ...fixture.artifact,
        source: input.source,
        content: input.content,
        assets: input.assets,
        review: { state: "pending", revision: 1 },
      };
      if (testBase)
        fixture.artifact = await testAPI("/v1/artifacts/create", input);
      return structuredClone(fixture.artifact);
    };
    dependencies.exchange.reportAvailability = async (input) => {
      if (testBase) return testAPI("/v1/media-assets/availability", input);
      const asset = fixture.assets.find((value) => value.id === input.id);
      asset.availability = {
        ...asset.availability,
        state: input.state,
        revision: asset.availability.revision + 1,
      };
      return structuredClone(asset);
    };
    const library = registerArtifactMedia(window, {
      identity: dependencies.identity,
      exchange: dependencies.exchange,
      producer: async (jobId) => ({
        source: { producer: "panorama", taskId: jobId, revision: 1 },
        content: structuredClone(fixture.artifact.content),
        files: { video: controlledVideo, cover: controlledCover },
        sample: false,
      }),
    });
    dependencies.resolver = library.registry;
    const service = registerPublishing(window, dependencies);
    await window.loadURL("keagent://app/integration.html");
    const call = (method, input = {}) =>
      window.webContents.executeJavaScript(
        `window.desktop.publishing.request(${JSON.stringify(method)},${JSON.stringify(input)})`,
      );
    const registered = await window.webContents.executeJavaScript(
      'window.desktop.artifactMedia.request("producer.register",{jobId:"11111111-1111-4111-8111-111111111111"})',
    );
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.equal(registered.data.review.state, "pending");
    assert.equal(assetRequests.size, 2);
    assert.ok(!JSON.stringify(registered).includes(root));
    const replay = await window.webContents.executeJavaScript(
      'window.desktop.artifactMedia.request("producer.register",{jobId:"11111111-1111-4111-8111-111111111111"})',
    );
    assert.equal(replay.data.id, registered.data.id);
    assert.equal(assetRequests.size, 2);
    const resolved = await library.registry.resolve(
      fixture.assets.find((asset) => asset.kind === "video"),
    );
    assert.notEqual(resolved.absolutePath, controlledVideo);
    // The explicit reviewer action is represented by the controlled exchange here; UI tests exercise its confirmation dialog.
    if (testBase) {
      fixture.artifact = await testAPI("/v1/artifacts/review", {
        id: fixture.artifact.id,
        expectedRevision: fixture.artifact.review.revision,
        state: "approved",
      });
      Object.assign(
        fixture,
        await testAPI("/v1/artifact-handoffs/create", {
          requestKey: "registry-integration-handoff-001",
          artifactId: fixture.artifact.id,
          expectedReviewRevision: fixture.artifact.review.revision,
        }),
      );
    } else fixture.artifact.review = { state: "approved", revision: 2 };
    const state = await call("state");
    assert.equal(state.ok, true);
    assert.equal(state.data.resolverAvailable, true);
    const added = await call("account.add");
    assert.equal(added.ok, true, JSON.stringify(added));
    const accountId = added.data.id;
    const saved = await call("account.save", { accountId });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.data.loginStatus, "logged_in");
    assert.equal(saved.data.platformUserId, "controlled-public-id");
    const nativeView = window.contentView.children.find(
      (view) => view.webContents,
    );
    assert.ok(nativeView);
    assert.equal(
      await nativeView.webContents.executeJavaScript("typeof window.desktop"),
      "undefined",
    );
    assert.equal(nativeView.webContents.getLastWebPreferences().sandbox, true);
    const added2 = await call("account.add");
    assert.equal(added2.ok, true);
    assert.notEqual(sessions[0].getStoragePath(), sessions[1].getStoragePath());
    const held = await call("observation.start", {
      accountId: added2.data.id,
      url: "https://www.douyin.com/video/10001",
    });
    assert.equal(
      (await call("observation.list")).data.find((r) => r.id === held.data.id)
        .state,
      "queued",
    );
    await call("observation.cancel", { id: held.data.id });
    assert.equal(
      (await call("observation.list")).data.find((r) => r.id === held.data.id)
        .errorCode,
      "CANCELED",
    );
    const observe = async (
      id,
      screenshotOnIssue = false,
      url = "https://www.douyin.com/video/" + id,
    ) => {
      const start = await call("observation.start", {
        accountId,
        url,
        screenshotOnIssue,
      });
      assert.equal(start.ok, true, JSON.stringify(start));
      for (let attempt = 0; attempt < 100; attempt++) {
        const history = await call("observation.list");
        const result = history.data.find((r) => r.id === start.data.id);
        if (result?.endedAt) {
          assert.ok(
            !JSON.stringify(result).includes("PRIVATE COMMENT FIXTURE"),
          );
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Observation fixture timed out");
    };
    const empty = await observe(
      "10001",
      false,
      "https://www.douyin.com/user/test-author?from_tab_name=main&modal_id=10001&vid=10007",
    );
    assert.equal(empty.targetUrl, "https://www.douyin.com/video/10001");
    assert.ok(
      !requests.some(
        (p) => p.includes("from_tab_name") || p.startsWith("/user/test-author"),
      ),
    );
    assert.equal(empty.panelStatus, "explicitly_empty", JSON.stringify(empty));
    const cancelRunning = await call("observation.start", {
      accountId,
      url: "https://www.douyin.com/video/10010",
    });
    const canceledId = cancelRunning.data.id;
    const currentObservation = async () =>
      (await call("observation.list")).data.find((r) => r.id === canceledId);
    for (
      let i = 0;
      i < 50 && (await currentObservation()).state === "queued";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await currentObservation()).state, "running");
    await call("observation.cancel", { id: canceledId });
    for (let i = 0; i < 80 && !(await currentObservation()).endedAt; i++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await currentObservation()).errorCode, "CANCELED");
    const hidden = await observe("10002", true);
    assert.equal(hidden.panelStatus, "not_visible", JSON.stringify(hidden));
    assert.equal(hidden.author.name, "其他作者");
    assert.equal(hidden.verifiedWorkId, "10002");
    assert.equal(hidden.screenshotSaved, true, JSON.stringify(hidden));
    assert.match(
      (await call("observation.screenshot", { id: hidden.id })).data,
      /^data:image\/png;base64,iVBOR/,
    );
    assert.equal((await observe("10003")).errorCode, "LOGIN_REQUIRED");
    assert.equal((await observe("10004")).errorCode, "VERIFICATION_REQUIRED");
    assert.equal((await observe("10005")).errorCode, "TARGET_REDIRECT");
    assert.equal((await observe("10006")).errorCode, "TARGET_REDIRECT");
    assert.equal((await observe("10007")).errorCode, "WORK_MISMATCH");
    assert.equal((await observe("10008")).panelStatus, "visible");
    assert.equal((await observe("10009")).errorCode, "AUTHOR_UNCONFIRMED");
    assert.equal((await observe("10010")).panelStatus, "loading");
    assert.equal((await observe("10011")).panelStatus, "load_failed");
    assert.equal((await observe("10012")).panelStatus, "unknown");
    const currentLayout = await observe("10013");
    assert.equal(currentLayout.verifiedWorkId, "10013");
    assert.equal(currentLayout.author.name, "夹具作者");
    assert.equal(currentLayout.panelStatus, "visible");
    assert.equal((await observe("10014")).errorCode, "IDENTITY_UNCONFIRMED");
    assert.equal((await observe("10015")).errorCode, "AUTHOR_UNCONFIRMED");
    if (testBase) {
      const target = await testAPI("/v1/collection/targets/create", {
        accountId,
        kind: "video",
        value: "https://www.douyin.com/video/10013",
        name: "夹具作品观察",
        requestKey: "electron-collection-target-001",
      });
      const input = {
        targetId: target.id,
        expectedVersion: target.version,
        requestKey: "electron-collection-run-001",
      };
      const run = await call("collection.start", input);
      assert.equal(run.ok, true, JSON.stringify(run));
      let result;
      for (let i = 0; i < 100; i++) {
        result = await testAPI("/v1/collection/runs/get", { id: run.data.id });
        if (result.endedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(result.state, "succeeded", JSON.stringify(result));
      assert.equal(result.panelStatus, "visible");
      assert.equal(result.verifiedWorkId, "10013");
      assert.equal(result.author.name, "夹具作者");
      assert.ok(!JSON.stringify(result).includes("PRIVATE COMMENT FIXTURE"));
      const duplicate = await call("collection.start", input);
      assert.equal(duplicate.data.id, result.id);
      const history = await testAPI("/v1/collection/runs/list", {
        targetId: target.id,
      });
      assert.deepEqual(
        history.items.map((r) => r.id),
        [result.id],
      );
      const videos = await testAPI("/v1/collection/videos/list", {
        targetId: target.id,
      });
      assert.equal(videos.items.length, 1);
      assert.equal(videos.items[0].lastRunId, result.id);
      await verifyCommentSync(
        testAPI,
        result.verifiedWorkId,
        accountId,
        fixture.ownerId,
        fixture.deviceId,
      );
      const local = await call("observation.list");
      assert.ok(
        local.data.some(
          (r) =>
            r.id === result.id && r.verifiedWorkId === result.verifiedWorkId,
        ),
      );
      assert.equal((await call("account.open", { accountId })).ok, true);
      const workLoads = () =>
        requests.filter((entry) => entry === "/video/10013").length;
      const before = workLoads();
      const heldRun = await call("collection.start", {
        ...input,
        requestKey: "electron-collection-held-002",
      });
      assert.equal(heldRun.ok, true, JSON.stringify(heldRun));
      const heldLocal = (await call("observation.list")).data.find(
        (r) => r.id === heldRun.data.id,
      );
      assert.equal(heldLocal.state, "queued");
      const cancellation = await call("collection.cancel", {
        id: heldRun.data.id,
      });
      assert.equal(cancellation.data.state, "canceled");
      assert.equal((await call("browser.hide")).ok, true);
      assert.equal(workLoads(), before);
      assert.equal(
        (await testAPI("/v1/collection/runs/get", { id: heldRun.data.id }))
          .state,
        "canceled",
      );
      assert.equal(
        (await testAPI("/v1/collection/videos/list", { targetId: target.id }))
          .items[0].lastRunId,
        result.id,
      );
      let version = target.version;
      for (const action of ["offline", "pause", "archive"]) {
        assert.equal((await call("account.open", { accountId })).ok, true);
        const queued = await call("collection.start", {
          ...input,
          expectedVersion: version,
          requestKey: "electron-collection-target-" + action,
        });
        assert.equal(queued.ok, true, JSON.stringify(queued));
        const localRun = async () =>
          (await call("observation.list")).data.find(
            (r) => r.id === queued.data.id,
          );
        assert.equal((await localRun()).state, "queued");
        if (action === "offline") {
          dropLeaseRenewal = true;
        } else {
          const change = await testAPI("/v1/collection/targets/" + action, {
            id: target.id,
            expectedVersion: version,
          });
          assert.equal(change.canceledRunId, queued.data.id);
          version = change.version;
          // Pause simulates a missed local notification. Archive uses the main process hook.
          if (action === "archive") {
            await service.targetStopped(change.canceledRunId, generation);
          }
        }
        assert.equal((await call("browser.hide")).ok, true);
        let stopped;
        for (let attempt = 0; attempt < 100; attempt++) {
          stopped = await localRun();
          if (stopped?.endedAt) break;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        const errorCode =
          action === "offline" ? "COLLECTION_UNAVAILABLE" : "CANCELED";
        assert.equal(stopped?.errorCode, errorCode, JSON.stringify(stopped));
        assert.equal(stopped.panelStatus, "not_checked");
        assert.equal(
          workLoads(),
          before,
          action + " must prevent work navigation",
        );
        dropLeaseRenewal = false;
        let remote;
        for (let attempt = 0; attempt < 100; attempt++) {
          remote = await testAPI("/v1/collection/runs/get", {
            id: queued.data.id,
          });
          if (remote.endedAt) break;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.equal(remote.errorCode, errorCode, JSON.stringify(remote));
        if (action === "pause") {
          const resumed = await testAPI("/v1/collection/targets/resume", {
            id: target.id,
            expectedVersion: version,
          });
          version = resumed.version;
        }
      }
      console.log("Collection IPC and shared API passed.");
    }
    assert.equal(
      nativeView.webContents.getURL().startsWith("https://creator.douyin.com/"),
      true,
    );
    console.log("Observation IPC and same-Profile Electron fixture passed.");
    if (!testBase) {
      const contact = { workId: "10001", accountId, id: "3".repeat(32) };
      const opened = await call("collection.contact", contact);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal(opened.data.activeAccountId, accountId);
      assert.equal(nativeView.webContents.getURL(), contactProfile);
      assert.equal(nativeView.webContents.session, sessions[0]);
      assert.equal(contactChecks, 1);
      assert.equal((await call("browser.hide")).ok, true);
      contactProfile =
        "https://www.douyin.com/user/fixture-commenter?modal_id=10001";
      const denied = await call("collection.contact", contact);
      assert.equal(denied.error.code, "INVALID_CONTACT_PROFILE");
      contactAccountMarker = "different-id";
      const mismatch = await call("collection.contact", contact);
      assert.equal(mismatch.error.code, "ACCOUNT_CHANGED");
      assert.equal(contactChecks, 2);
      contactAccountMarker = "controlled-public-id";
      console.log(
        "Manual contact verified in the original Electron Profile; wrong account and non-profile URL rejected.",
      );
    }
    if (!testBase) {
      const read = (accountId, url) =>
        call("social.start", {
          accountId,
          url,
          requestKey: crypto.randomUUID(),
          consent: { accepted: true },
        });
      const dy = await read(accountId, "https://www.douyin.com/video/12345");
      assert.equal(dy.ok, true, JSON.stringify(dy));
      assert.equal(commentImports[0].accountId, accountId);
      assert.deepEqual(
        commentImports[0].items.map((c) => c.comment_id),
        ["first", "second"],
      );
      const xhs = await call("account.add", { platform: "xhs" });
      assert.ok(xhs.ok, JSON.stringify(xhs));
      const xhsSaved = await call("account.save", { accountId: xhs.data.id });
      assert.equal(
        xhsSaved.data?.platformUserId,
        xhsUserId,
        JSON.stringify(xhsSaved),
      );
      await call("browser.hide");
      const xhsResult = await read(
        xhs.data.id,
        "https://www.xiaohongshu.com/explore/" + noteId,
      );
      assert.ok(xhsResult.ok, JSON.stringify(xhsResult));
      assert.equal(commentImports[1].accountId, xhs.data.id);
      assert.equal(commentImports[1].workId, "xhs-" + noteId);
      assert.deepEqual(
        commentImports[1].items.map((c) => c.comment_id).sort(),
        ["page", "ssr"],
      );
      console.log(
        "Native comment collection verified for both saved profiles, first-page SSR, pagination, deduplication, and work isolation.",
      );
    }
    const input = {
      requestKey: "electron-publish-fixture-0001",
      handoffId: fixture.id,
      accountId,
      title: "集成测试视频",
      description: "仅测试适配器\n\n后续一段",
      hashtags: ["测试"],
      scheduledAt,
    };
    const started = await call("publish.start", input);
    assert.equal(started.ok, true, JSON.stringify(started));
    await service.publisher.idle();
    if (failVideo || failCover || scheduleTest?.endsWith("mismatch")) {
      const record = service.publisher.active;
      assert.equal(
        record.state,
        scheduleTest === "request_mismatch" ? "unknown" : "failed",
      );
      assert.equal(
        record.errorCode,
        failVideo
          ? "VIDEO_UPLOAD_FAILED"
          : failCover
            ? "COVER_UPLOAD_FAILED"
            : scheduleTest === "readback_mismatch"
              ? "SCHEDULE_TIME_MISMATCH"
              : "PUBLISH_OUTCOME_UNKNOWN",
      );
      if (scheduleTest !== "request_mismatch")
        assert.ok(
          !record.logs.some(
            (entry) =>
              entry.step ===
              (failVideo
                ? "upload_cover"
                : failCover
                  ? "publish_settings"
                  : "submit_page_request"),
          ),
        );
      assert.equal(submits, 0);
      service.stop();
      window.destroy();
      console.log(
        `Hidden Electron verified: ${record.errorCode} stops before submission.`,
      );
      app.exit(0);
      return;
    }
    assert.equal(
      service.publisher.active.state,
      "accepted",
      JSON.stringify(service.publisher.active),
    );
    assert.equal(submits, 1);
    await call("publish.start", input);
    assert.equal(submits, 1);
    assert.ok(requests.includes("/creator-micro/content/upload"));
    assert.equal(service.publisher.active.externalId, "7612345678901234567");
    const publicState = await call("state");
    assert.equal(records.get(input.requestKey).state, "accepted");
    const interrupted = {
      ...records.get(input.requestKey),
      requestKey: "interrupted-publish-key-001",
      id: "2".repeat(32),
      state: "submitting",
      externalId: undefined,
      url: undefined,
      resultSource: undefined,
    };
    if (testBase) {
      const created = await dependencies.request("/v1/douyin/records/create", {
        ...input,
        requestKey: interrupted.requestKey,
      });
      interrupted.id = created.record.id;
      await dependencies.request("/v1/douyin/records/report", interrupted);
    }
    records.set(interrupted.requestKey, interrupted);
    const ownerFolder = crypto
      .createHash("sha256")
      .update(`${fixture.ownerId}:${fixture.deviceId}`)
      .digest("hex");
    const pendingRoot = path.join(root, "douyin", ownerFolder, "pending");
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pendingRoot, `${interrupted.id}.json`),
      JSON.stringify(interrupted),
    );
    await call("state");
    assert.equal(records.get(interrupted.requestKey).state, "unknown");
    assert.equal(submits, 1);
    assert.ok(!JSON.stringify(publicState).includes("explicit-test-cookie"));
    assert.ok(!JSON.stringify(publicState).includes(root));
    const hostile = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(project, "apps/desktop/electron/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.push(hostile);
    await hostile.loadURL("data:text/html,<h1>Untrusted surface</h1>");
    const denied = await hostile.webContents.executeJavaScript(
      'window.desktop.publishing.request("state",{})',
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "FORBIDDEN");
    generation++;
    service.stop();
    assert.equal((await call("state")).data.tabs.length, 0);
    service.stop();
    for (const win of windows) win.destroy();
    console.log(
      "Hidden Electron verified: real file registration, explicit review, isolated login, video and cover upload, form input, single submit and recovery.",
    );
    app.exit(0);
  } catch (error) {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.error(error);
    app.exit(1);
  }
});
