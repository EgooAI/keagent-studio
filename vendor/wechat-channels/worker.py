"""Run the upstream video publisher in this account's standalone browser."""

import asyncio
import base64
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from playwright.async_api import Error as BrowserError, async_playwright
from uploader.tencent_uploader.main import (
    TENCENT_HOME_URL,
    TENCENT_MANAGE_URL,
    TENCENT_PUBLISH_STRATEGY_IMMEDIATE,
    TENCENT_PUBLISH_STRATEGY_SCHEDULED,
    TencentVideo,
)
from utils.log import tencent_logger


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=True), flush=True)


class JobError(Exception):
    def __init__(self, code, message, stage=None):
        super().__init__(message)
        self.code = code
        self.stage = stage


def absolute_directory(value):
    directory = Path(value)
    if not directory.is_absolute():
        raise ValueError("视频号工作目录必须是绝对路径")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory


class AccountPage:
    """The upstream launch/context operations borrow this persistent Chrome page."""

    def __init__(self, page):
        self.page = page

    async def launch(self, **_):
        return self

    async def new_context(self, **_):
        return self

    async def new_page(self):
        return self.page

    async def storage_state(self, **_):
        # Chrome maintains the account's session in its dedicated profile.
        pass

    async def close(self):
        # The outer job closes the persistent context once.
        pass


class ChromeVideo(TencentVideo):
    async def validate_base_args(self):
        # The live account preflight replaces the upstream external cookie probe.
        if self.publish_strategy == TENCENT_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)

    async def submit_publish(self, page):
        account = await read_account(page, self.account_probe, 8)
        require_account(account, self.expected_account, stage="beforeSubmit")
        emit("beforeSubmit")
        if (await self.commands.get()).get("ok") is not True:
            raise RuntimeError("桌面端未确认提交")
        await super().submit_publish(page)


def bundled_resources():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent / "channels-browser"
    return Path(__file__).resolve().parents[2] / "output" / "channels-browser"


def bundled_binary():
    directory = bundled_resources()
    expected = "chrome.exe" if sys.platform == "win32" else "Chromium.app/Contents/MacOS/Chromium"
    try:
        manifest = json.loads((directory / "browser.json").read_text(encoding="utf-8"))
        version = manifest["version"]
        if manifest["executable"] != expected or not re.fullmatch(r"\d+(?:\.\d+){3}", version):
            raise ValueError("invalid browser manifest")
        binary = (directory / expected).resolve(strict=True)
        if not binary.is_relative_to(directory.resolve()):
            raise ValueError("unexpected browser location")
        with binary.open("rb") as stream:
            digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
            if digest.hexdigest() != manifest["sha256"]:
                raise ValueError("browser checksum mismatch")
        return binary, version
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise JobError("BROWSER_COMPONENT_UNAVAILABLE", "视频号专用浏览器文件不可用，请修复或更新 AI来客") from error


def system_chrome_candidates():
    if sys.platform == "win32":
        import winreg
        for name in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"):
            if os.environ.get(name):
                yield Path(os.environ[name]) / "Google" / "Chrome" / "Application" / "chrome.exe"
        key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                try:
                    with winreg.OpenKey(hive, key, access=winreg.KEY_READ | view) as handle:
                        value = Path(os.path.expandvars(winreg.QueryValueEx(handle, "")[0].strip('"')))
                except FileNotFoundError:
                    continue
                if value.is_absolute() and value.name.lower() == "chrome.exe":
                    yield value
    elif sys.platform == "darwin":
        for apps in (Path("/Applications"), Path.home() / "Applications"):
            yield apps / "Google Chrome.app" / "Contents" / "MacOS" / "Google Chrome"


def alternate_chrome_installation():
    # The driver reports "not found" for any access failure in its standard paths.
    # Confirm absence and check nonstandard registered installations before fallback.
    try:
        for candidate in system_chrome_candidates():
            try:
                mode = candidate.stat().st_mode
            except (FileNotFoundError, NotADirectoryError):
                continue
            if not stat.S_ISREG(mode):
                raise JobError("BROWSER_START_FAILED", "系统 Chrome 安装路径不可用")
            return candidate
    except OSError as error:
        raise JobError("BROWSER_START_FAILED", "无法访问系统 Chrome 安装位置") from error
    return None


def chromium_profile(directory):
    directory = Path(directory)
    return directory.with_name("chromium-profile" if directory.name == "chrome-profile" else directory.name + "-chromium")


async def launch_bundled(playwright, directory, *, headless):
    binary, version = bundled_binary()
    profile = chromium_profile(directory)
    pin = profile / ".ai-laike-browser-version"
    try:
        for stamp in (pin, profile / "Last Version"):
            if stamp.exists():
                previous = stamp.read_text(encoding="utf-8").strip()
                if not re.fullmatch(r"\d+(?:\.\d+){3}", previous):
                    raise JobError("BROWSER_PROFILE_NEWER", "无法确认视频号浏览器资料版本，已保留账号资料")
                if tuple(map(int, previous.split("."))) > tuple(map(int, version.split("."))):
                    raise JobError("BROWSER_PROFILE_NEWER", "该视频号资料来自更新的浏览器，请更新 AI来客")
        context = await launch_context(playwright, profile, headless, executable_path=str(binary))
        try:
            temporary = pin.with_suffix(".tmp")
            temporary.write_text(version, encoding="utf-8")
            temporary.replace(pin)
        except BaseException:
            await context.close()
            raise
        return context
    except OSError as error:
        raise JobError("EXECUTION_FAILED", "无法打开视频号的专用浏览器资料目录") from error


async def launch_context(playwright, directory, headless, **executable):
    try:
        return await playwright.chromium.launch_persistent_context(
            str(directory), **executable, headless=headless,
            no_viewport=True, chromium_sandbox=True,
        )
    except BrowserError as error:
        detail = str(error).lower()
        if ("processsingleton" in detail or "user data directory is already in use" in detail
                or re.search(r"process did exit: exitcode=(21|24),", detail)):
            raise JobError("PROFILE_BUSY", "此视频号的浏览器正在使用，请先关闭对应窗口") from error
        if executable.get("channel") == "chrome" and "chromium distribution 'chrome' is not found" in detail:
            raise JobError("CHROME_NOT_FOUND", "未找到系统 Chrome") from error
        raise JobError("BROWSER_START_FAILED", "视频号浏览器启动失败，请检查系统权限和账号窗口") from error


async def launch_chrome(playwright, directory, *, headless):
    dedicated = chromium_profile(directory)
    if (dedicated / ".ai-laike-browser-version").is_file() or (dedicated / "Local State").is_file():
        return await launch_bundled(playwright, directory, headless=headless)
    try:
        return await launch_context(playwright, directory, headless, channel="chrome")
    except JobError as error:
        if error.code != "CHROME_NOT_FOUND":
            raise
    alternate = alternate_chrome_installation()
    if alternate:
        return await launch_context(playwright, directory, headless, executable_path=str(alternate))
    return await launch_bundled(playwright, directory, headless=headless)


async def read_account(page, probe, timeout):
    end = asyncio.get_running_loop().time() + timeout
    while True:
        if page.is_closed():
            raise JobError("LOGIN_CLOSED", "视频号窗口已关闭")
        try:
            result = await page.evaluate("(" + probe + ")()")
        except BrowserError:
            # The QR callback may replace the document between checks.
            result = None
        if not isinstance(result, dict):
            result = {"status": "unknown"}
        if result.get("status") == "logged_in" and result.get("id"):
            return result
        if asyncio.get_running_loop().time() >= end:
            return result
        await asyncio.sleep(0.5)


def require_account(result, expected, stage="preflight"):
    if result.get("status") in ("expired", "logged_out"):
        raise JobError("LOGIN_REQUIRED", "视频号需要重新扫码登录", stage)
    if result.get("status") != "logged_in" or not result.get("id"):
        raise JobError("EXECUTION_FAILED", "无法确认当前视频号，请检查账号状态", stage)
    if expected and result["id"] != expected:
        raise JobError("ACCOUNT_MISMATCH", "当前登录的视频号与任务绑定的账号不一致", stage)


async def upload(page, job, commands):
    data = job["input"]
    scheduled_at = data.get("scheduledAt")
    date = datetime.fromtimestamp(scheduled_at, timezone(timedelta(hours=8))) if scheduled_at else None
    if date and (date.minute or date.second or date.microsecond):
        raise ValueError("视频号定时发布只支持北京时间整点")
    uploader = ChromeVideo(
        title=data["title"],
        tags=[tag.removeprefix("#") for tag in data["hashtags"]],
        desc=data["description"],
        file_path=job["videoPath"],
        thumbnail_path=job.get("coverPath"),
        account_file=Path(job["debugDir"]) / "wechat",
        publish_date=date or 0,
        publish_strategy=TENCENT_PUBLISH_STRATEGY_SCHEDULED if date else TENCENT_PUBLISH_STRATEGY_IMMEDIATE,
    )
    uploader.commands = commands
    uploader.expected_account = job["expectedAccountId"]
    uploader.account_probe = job["accountProbe"]

    def show_verification(message):
        # The original warning is emitted immediately after its screenshot is saved.
        if "需要管理员微信扫码完成实名验证" in message.record["message"]:
            emit("verification", qrFile="wechat_verification_qr.png")
        elif "管理员实名验证已完成" in message.record["message"]:
            emit("verificationDone")

    tencent_logger.remove()
    tencent_logger.add(show_verification, level="SUCCESS", catch=False)
    emit("progress", value=10)
    await uploader.upload(SimpleNamespace(chromium=AccountPage(page)))


async def perform_action(context, job, commands):
    action = job["action"]
    page = context.pages[0] if context.pages else await context.new_page()
    await page.goto(TENCENT_HOME_URL, wait_until="domcontentloaded", timeout=60000)
    if action in ("login", "manage"):
        emit("opened")
    account = await read_account(page, job["accountProbe"], 300 if action in ("login", "manage") else 8)
    if action == "check":
        return {"event": "account", **account}
    if action == "publish" and not job.get("expectedAccountId"):
        raise ValueError("发布前必须指定已绑定的视频号")
    require_account(account, job.get("expectedAccountId"))
    if action == "manage":
        # A full navigation to /post/list redirects back to the dashboard.
        try:
            await page.get_by_text("全部视频", exact=True).filter(visible=True).first.click(timeout=20000)
            await page.wait_for_url(TENCENT_MANAGE_URL + "**", timeout=20000)
        except BrowserError as error:
            if page.is_closed():
                return {"event": "closed"}
            raise JobError("EXECUTION_FAILED", "微信视频号助手未能打开全部视频列表") from error
        if not page.is_closed():
            await page.wait_for_event("close", timeout=0)
        return {"event": "closed"}
    if action == "login":
        return {"event": "account", **account}
    await upload(page, job, commands)
    return {"event": "accepted"}


async def run_job(job, commands):
    action = job["action"]
    if action not in ("check", "login", "manage", "publish"):
        raise ValueError("未知的视频号操作")
    profile = absolute_directory(job["profileDir"])
    if action == "publish":
        os.chdir(absolute_directory(job["debugDir"]))
    async with async_playwright() as playwright:
        context = await launch_chrome(playwright, profile, headless=action in ("check", "publish"))
        try:
            result = await perform_action(context, job, commands)
        finally:
            await context.close()
    emit(**result)


async def verify_browser(playwright, directory, bundled_only, live_login=False):
    profile = Path(directory) / "chrome-profile"
    launch = launch_bundled if bundled_only else launch_chrome
    context = await launch(playwright, profile, headless=True)
    try:
        page = context.pages[0]
        session = await context.new_cdp_session(page)
        product = (await session.send("Browser.getVersion"))["product"].split("/")[-1]
        backend = "system"
        if bundled_only or (chromium_profile(profile) / ".ai-laike-browser-version").is_file():
            binary, version = bundled_binary()
            await page.goto("chrome://version")
            actual = Path((await page.locator("#executable_path").inner_text()).strip()).resolve()
            if actual != binary or product != version:
                raise RuntimeError("自检启动的浏览器与安装清单不匹配")
            backend = "bundled"
        if live_login:
            await page.goto(TENCENT_HOME_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_url("https://channels.weixin.qq.com/login.html**", timeout=30000)
            frame = page.frame_locator('iframe[src*="open.weixin.qq.com/connect/qrconnect"]').first
            qr = frame.locator("img.js_qrcode_img:visible, img.qrcode:visible").first
            await qr.wait_for(state="visible", timeout=30000)
            decoded = await asyncio.wait_for(qr.evaluate(
                "async img => { await img.decode(); return img.naturalWidth > 0 && img.naturalHeight > 0; }"
            ), timeout=15)
            if not decoded or await page.locator(".qrcode-wrap .mask.show").first.is_visible():
                raise RuntimeError("视频号助手未显示可用的登录二维码")
            return {"browser": backend, "version": product, "loginPage": True, "qrImageLoaded": True}
        sample = Path(__file__).with_name("browser-probe.mp4").read_bytes()
        html = '<title>Channels browser probe</title><video muted preload="auto" src="data:video/mp4;base64,' + base64.b64encode(sample).decode("ascii") + '"></video>'
        await page.route("http://channels-probe.invalid/", lambda route: route.fulfill(content_type="text/html", body=html))
        await page.goto("http://channels-probe.invalid/", wait_until="domcontentloaded", timeout=15000)
        if await page.title() != "Channels browser probe":
            raise RuntimeError("专用浏览器未能加载自检网页")
        pixel = await page.evaluate("""async () => {
          const video = document.querySelector('video');
          if (video.readyState < 2) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('decode timeout')), 10000);
            video.onloadeddata = () => { clearTimeout(timer); resolve(); };
            video.onerror = () => { clearTimeout(timer); reject(Error('decode failed')); };
          });
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, 1, 1);
          return Array.from(ctx.getImageData(0,0,1,1).data);
        }""")
        if not (pixel[0] > 160 and pixel[1] < 50 and pixel[2] < 50 and pixel[3] == 255):
            raise RuntimeError("专用浏览器未能解码 H.264 测试帧")
        return {"browser": backend, "version": product, "h264": True}
    finally:
        await context.close()


async def main():
    os.environ.pop("PLAYWRIGHT_NODEJS_PATH", None)
    if sys.argv[1:] in (["--chrome-self-test"], ["--bundled-chrome-self-test"], ["--bundled-chrome-login-check"]):
        with tempfile.TemporaryDirectory(prefix="keagent-browser-check-") as root:
            async with async_playwright() as playwright:
                result = await verify_browser(playwright, root, bundled_only=sys.argv[1] != "--chrome-self-test",
                                              live_login=sys.argv[1] == "--bundled-chrome-login-check")
        emit("ready", **result)
        return
    if sys.argv[1:] == ["--self-test"]:
        async with async_playwright() as playwright:
            assert playwright.chromium.name == "chromium"
        emit("ready")
        return
    stream = open(sys.stdin.fileno(), "rb", buffering=0, closefd=False)
    job = json.loads(stream.readline())
    loop = asyncio.get_running_loop()
    commands = asyncio.Queue()
    task = asyncio.create_task(run_job(job, commands))

    def read_commands():
        try:
            for line in stream:
                loop.call_soon_threadsafe(commands.put_nowait, json.loads(line))
        finally:
            # Closing stdin cancels an active upload/wait and flushes Chrome's profile.
            if not loop.is_closed():
                loop.call_soon_threadsafe(task.cancel)

    threading.Thread(target=read_commands, daemon=True).start()
    try:
        await task
    except asyncio.CancelledError:
        pass


def report_error(error):
    if isinstance(error, JobError):
        stage = {"stage": error.stage} if error.stage else {}
        emit("error", code=error.code, message=str(error), **stage)
        return
    # Driver exceptions may include local filenames, raw URLs or private page content.
    public_types = (RuntimeError, TimeoutError, ValueError, FileNotFoundError)
    message = str(error) if type(error) in public_types else "无法完成视频号浏览器操作"
    code = "EXECUTION_FAILED"
    if isinstance(error, RuntimeError) and message.startswith("视频号 cookie 已失效"):
        code = "LOGIN_REQUIRED"
    elif isinstance(error, TimeoutError) and message == "等待视频号管理员实名验证超时":
        code = "VERIFICATION_REQUIRED"
    emit("error", code=code, message=message)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        report_error(error)
        sys.exit(1)
