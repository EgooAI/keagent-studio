"""Run the original workflow in installed, headless Chrome against local HTML only."""
import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor/wechat-channels"))
import worker
from playwright.async_api import async_playwright


ORIGIN = "https://channels.weixin.qq.com"
DATE = (datetime.now(timezone(timedelta(hours=8))) + timedelta(hours=5)).replace(
    minute=0, second=0, microsecond=0
)
HOME = """<button class="weui-desktop-btn" onclick="location.href='/platform/post/create'">发表视频</button>
<span hidden>全部视频</span><button onclick="history.pushState({},'', '/platform/post/list')">全部视频</button>"""
FORM = """<!doctype html><meta charset="utf-8">
<iframe src="/input"></iframe>
<div class="weui-desktop-dialog__wrp">管理员实名验证</div>
<div class="input-editor" contenteditable="true"> </div>
<button onclick="this.nextElementSibling.hidden=false">选择视频标注</button>
<button hidden onclick="document.body.dataset.label=this.textContent">含AI生成内容</button>
<div class="vertical-cover-wrap" onclick="document.querySelector('template').replaceWith(document.querySelector('template').content.cloneNode(true))">个人主页卡片 3:4</div>
<template><div class="weui-desktop-dialog">编辑个人主页卡片
<div class="single-cover-uploader-wrap"><input id="portrait" type="file"></div>
<div class="weui-desktop-dialog__ft"><button class="weui-desktop-btn_primary" onclick="document.body.dataset.cover=portrait.files[0].name;this.closest('.weui-desktop-dialog').remove()">确认</button></div>
</div></template>
<label>定时</label><label onclick="document.body.dataset.scheduled='yes'">定时</label>
<input placeholder="请选择发表时间"><span class="weui-desktop-picker__panel__label">MONTH月</span>
<table class="weui-desktop-picker__table"><tr><td><a onclick="document.body.dataset.day=this.textContent">DAY</a></td></tr></table>
<input id="hour" placeholder="请选择时间"><input id="short" placeholder="填写短标题有机会获得更多流量">
<div class="form-btns"><button disabled onclick="finish()">发表</button></div>
<script>
let submits=0;
function finish() {
  if (++submits!==2) return;
  localStorage.fixtureResult=JSON.stringify({...document.body.dataset, submits,
    short:document.querySelector('#short').value, hour:document.querySelector('#hour').value,
    editor:document.querySelector('.input-editor').innerText});
  history.pushState({},'', '/platform/post/list');
}
</script>""".replace("MONTH", DATE.strftime("%m")).replace("DAY", str(DATE.day))
INPUT = """<input type="file" onchange="parent.document.body.dataset.video=this.files[0].name;parent.document.querySelector('.form-btns button').disabled=false">"""


async def fixture_route(route):
    url = urlsplit(route.request.url)
    if url.hostname != "channels.weixin.qq.com":
        await route.abort()
        return
    html = {"/platform": HOME, "/platform/post/create": FORM, "/input": INPUT}.get(url.path, "")
    if html and url.path.startswith("/platform"):
        html += "<script>window._store={userStore:{finderUsername:'fixture'}};</script>"
    await route.fulfill(status=200 if html else 404, content_type="text/html; charset=utf-8", body=html)


async def run_test(directory, bundled=False):
    original_launch = worker.launch_bundled if bundled else worker.launch_chrome
    profile = directory / "account-a"
    commands = asyncio.Queue()
    events = []
    context = None

    async def launch_routed(driver, profile_dir, *, headless):
        nonlocal context
        assert headless
        context = await original_launch(driver, profile_dir, headless=headless)
        await context.route("**/*", fixture_route)
        return context

    def observe(event, **data):
        events.append(event)
        if event == "beforeSubmit":
            commands.put_nowait({"ok": True})
        elif event == "verification":
            assert (directory / data["qrFile"]).stat().st_size
            asyncio.create_task(context.pages[0].locator(".weui-desktop-dialog__wrp").evaluate("el=>el.remove()"))

    for name in ("样片.mp4", "封面.png"):
        (directory / name).write_bytes(b"local fixture")
    with patch.object(worker, "launch_chrome", launch_routed), patch.object(worker, "emit", observe):
        await worker.run_job({
            "action": "publish", "profileDir": str(profile), "debugDir": str(directory),
            "expectedAccountId": "fixture", "accountProbe": "() => ({status:'logged_in',id:window._store.userStore.finderUsername})",
            "input": {"title": "测试视频原版流程", "description": "后台Chrome实测",
                      "hashtags": ["#样片"], "scheduledAt": int(DATE.timestamp())},
            "coverPath": str(directory / "封面.png"), "videoPath": str(directory / "样片.mp4")
        }, commands)
    assert events == ["progress", "verification", "verificationDone", "beforeSubmit", "accepted"], events

    async with async_playwright() as driver:
        for profile_dir, logged_in in [(profile, True), (directory / "account-b", False)]:
            context = await launch_routed(driver, profile_dir, headless=True)
            try:
                page = context.pages[0]
                await page.goto(ORIGIN + "/platform")
                result = await page.evaluate("JSON.parse(localStorage.fixtureResult||'null')")
                if logged_in:
                    assert result["video"] == "样片.mp4" and result["cover"] == "封面.png", result
                    assert result["label"] == "含AI生成内容" and result["submits"] == 2, result
                    assert result["day"] == str(DATE.day) and result["hour"] == DATE.strftime("%H"), result
                    assert result["scheduled"] == "yes" and result["short"] == "测试视频原版流程", result
                    assert all(s in result["editor"] for s in ["测试视频原版流程", "#样片", "后台Chrome实测"])
                    assert "##" not in result["editor"]
                    manage = asyncio.create_task(worker.perform_action(context, {
                        "action": "manage", "expectedAccountId": "fixture",
                        "accountProbe": "() => ({status:'logged_in',id:window._store.userStore.finderUsername})"
                    }, commands))
                    await page.wait_for_url(ORIGIN + "/platform/post/list", timeout=10000)
                    await page.close()
                    assert (await manage)["event"] == "closed"
                else:
                    assert result is None
            finally:
                await context.close()


async def run_login_fixture(directory):
    """Model a human approval in a loopback iframe, then cold-start the saved profile."""
    origin = "http://127.0.0.1:43121"
    frame_origin = "http://127.0.0.1:43122"
    account = "local-test-account"
    main = f"""<h1>Local login fixture</h1><iframe src="{frame_origin}/scan"></iframe>
    <script>addEventListener("message", event => {{
      if (event.origin === "{frame_origin}" && event.source === document.querySelector("iframe").contentWindow &&
          event.data === "approved") localStorage.fixtureLogin = "{account}";
    }});</script>"""
    scan = f"""<p>Local scan fixture</p><button onclick="parent.postMessage('approved', '{origin}')">Approve fixture</button>"""
    async def routes(route):
        pages = {origin + "/login": main, frame_origin + "/scan": scan}
        body = pages.get(route.request.url)
        if body is None:
            await route.abort()
        else:
            await route.fulfill(content_type="text/html; charset=utf-8", body=body)

    launch = worker.launch_chrome
    opened = asyncio.Event()
    contexts = []
    events = []
    async def routed(driver, profile, *, headless):
        context = await launch(driver, profile, headless=headless)
        await context.route("**/*", routes)
        contexts.append((context, headless))
        return context

    def observe(event, **data):
        events.append((event, data))
        if event == "opened":
            opened.set()

    job = {
        "profileDir": str(directory / "chrome-profile"),
        "accountProbe": "() => localStorage.fixtureLogin ? {status:'logged_in',id:localStorage.fixtureLogin} : {status:'logged_out'}",
    }
    commands = asyncio.Queue()
    with patch.object(worker, "launch_chrome", routed), patch.object(worker, "TENCENT_HOME_URL", origin + "/login"), patch.object(worker, "emit", observe):
        login = asyncio.create_task(worker.run_job(dict(job, action="login"), commands))
        try:
            await asyncio.wait_for(opened.wait(), timeout=20)
            page = contexts[0][0].pages[0]
            assert not contexts[0][1]
            await page.frame_locator("iframe").get_by_role("button", name="Approve fixture").click(timeout=8000)
            await asyncio.wait_for(login, timeout=15)
        finally:
            if not login.done():
                login.cancel()
            await asyncio.gather(login, return_exceptions=True)
        await worker.run_job(dict(job, action="check"), commands)
    expected = ("account", {"status": "logged_in", "id": account})
    assert events == [("opened", {}), expected, expected], events
    assert len(contexts) == 2 and contexts[1][1]


if __name__ == "__main__":
    previous = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="keagent-channels-chrome-") as root:
        try:
            if sys.argv[1:] == ["--account-login-fixture"]:
                asyncio.run(run_login_fixture(Path(root)))
                print("Local login iframe approval and clean headless restart passed.")
            else:
                asyncio.run(run_test(Path(root), bundled=sys.argv[1:] == ["--bundled"]))
                print("Headless browser passed upload, verification, submit retry, cold restart and account isolation.")
        finally:
            os.chdir(previous)
