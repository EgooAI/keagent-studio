import asyncio
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import worker


class BrowserSelectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.system = root / "account" / "chrome-profile"
        self.bundle = root / "channels-browser"
        executable = "chrome.exe" if sys.platform == "win32" else "Chromium.app/Contents/MacOS/Chromium"
        self.binary = self.bundle / executable
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b"test binary")
        self.manifest = {
            "executable": executable, "version": "157.0.8.78",
            "sha256": hashlib.sha256(self.binary.read_bytes()).hexdigest(),
        }
        self.write_manifest()
        resources = patch.object(worker, "bundled_resources", return_value=self.bundle)
        resources.start()
        self.addCleanup(resources.stop)
        alternate = patch.object(worker, "alternate_chrome_installation", return_value=None)
        self.alternate = alternate.start()
        self.addCleanup(alternate.stop)
        self.launch = AsyncMock(side_effect=self.create_context)
        self.driver = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=self.launch))

    def write_manifest(self):
        (self.bundle / "browser.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def create_context(self, profile, **_):
        Path(profile).mkdir(parents=True, exist_ok=True)
        return SimpleNamespace(close=AsyncMock())

    async def test_system_chrome_always_uses_original_account_and_channel(self):
        self.binary.unlink()
        for headless in (True, False):
            await worker.launch_chrome(self.driver, self.system, headless=headless)
            self.launch.assert_awaited_with(
                str(self.system), headless=headless, channel="chrome", no_viewport=True, chromium_sandbox=True,
            )
        self.alternate.assert_not_called()

    async def test_only_missing_chrome_creates_a_separate_pinned_profile(self):
        def missing(profile, **options):
            if "channel" in options:
                raise worker.BrowserError("Chromium distribution 'chrome' is not found at the default path")
            return self.create_context(profile)

        self.system.mkdir(parents=True)
        old_state = self.system / "Local State"
        old_state.write_text("original", encoding="utf-8")
        self.launch.side_effect = missing
        await worker.launch_chrome(self.driver, self.system, headless=False)
        dedicated = self.system.with_name("chromium-profile")
        self.launch.assert_awaited_with(str(dedicated), executable_path=str(self.binary.resolve()), headless=False,
                                       no_viewport=True, chromium_sandbox=True)
        self.assertEqual((dedicated / ".ai-laike-browser-version").read_text(), self.manifest["version"])
        self.assertEqual(old_state.read_text(), "original")
        self.launch.reset_mock()
        self.launch.side_effect = self.create_context
        await worker.launch_chrome(self.driver, self.system, headless=True)
        self.launch.assert_awaited_once_with(str(dedicated), executable_path=str(self.binary.resolve()), headless=True,
                                             no_viewport=True, chromium_sandbox=True)

    async def test_registered_chrome_outside_default_path_stays_with_original_profile(self):
        alternate = self.system.parent.parent / "alternate" / "chrome.exe"
        self.alternate.return_value = alternate
        self.launch.side_effect = [worker.BrowserError("Chromium distribution 'chrome' is not found"), object()]
        await worker.launch_chrome(self.driver, self.system, headless=True)
        self.launch.assert_awaited_with(str(self.system), executable_path=str(alternate), headless=True,
                                       no_viewport=True, chromium_sandbox=True)
        self.assertFalse(worker.chromium_profile(self.system).exists())

    async def test_launch_failures_and_busy_profiles_do_not_switch_browser(self):
        for reason, code in [
            ("<process did exit: exitCode=21, signal=null>", "PROFILE_BUSY"),
            ("Failed to create ProcessSingleton", "PROFILE_BUSY"),
            ("DevToolsActivePort file not found", "BROWSER_START_FAILED"),
            ("access denied", "BROWSER_START_FAILED"),
        ]:
            with self.subTest(reason=reason):
                self.launch.side_effect = worker.BrowserError(reason)
                with self.assertRaises(worker.JobError) as raised:
                    await worker.launch_chrome(self.driver, self.system, headless=True)
                self.assertEqual(raised.exception.code, code)
                self.alternate.assert_not_called()
                self.assertFalse(worker.chromium_profile(self.system).exists())

    async def test_dedicated_profile_rejects_downgrade_without_switching_browser(self):
        profile = worker.chromium_profile(self.system)
        profile.mkdir(parents=True)
        (profile / "Local State").touch()
        for stamp in (".ai-laike-browser-version", "Last Version"):
            with self.subTest(stamp=stamp):
                file = profile / stamp
                file.write_text("158.0.0.1", encoding="utf-8")
                with self.assertRaises(worker.JobError) as raised:
                    await worker.launch_chrome(self.driver, self.system, headless=True)
                self.assertEqual(raised.exception.code, "BROWSER_PROFILE_NEWER")
                self.launch.assert_not_awaited()
                file.unlink()
        (profile / ".ai-laike-browser-version").write_text("156.0.0.1", encoding="utf-8")
        await worker.launch_chrome(self.driver, self.system, headless=True)
        self.assertEqual((profile / ".ai-laike-browser-version").read_text(), self.manifest["version"])

    def test_unusable_browser_component_never_selects_another_executable(self):
        for key, value in (("sha256", "invalid"), ("executable", "../chrome.exe"), ("version", "invalid")):
            with self.subTest(key=key), patch.dict(self.manifest, {key: value}):
                self.write_manifest()
                with self.assertRaises(worker.JobError) as raised:
                    worker.bundled_binary()
                self.assertEqual(raised.exception.code, "BROWSER_COMPONENT_UNAVAILABLE")
        (self.bundle / "browser.json").unlink()
        with self.assertRaises(worker.JobError) as raised:
            worker.bundled_binary()
        self.assertEqual(raised.exception.code, "BROWSER_COMPONENT_UNAVAILABLE")


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def test_installed_but_inaccessible_chrome_is_not_treated_as_missing(self):
        with patch.object(worker, "system_chrome_candidates", side_effect=PermissionError):
            with self.assertRaises(worker.JobError) as raised:
                worker.alternate_chrome_installation()
            self.assertEqual(raised.exception.code, "BROWSER_START_FAILED")

    def test_account_intervention_errors(self):
        for error, code in [
            (RuntimeError("视频号 cookie 已失效（被跳转到登录页），请重新扫码登录后再发布"), "LOGIN_REQUIRED"),
            (TimeoutError("等待视频号管理员实名验证超时"), "VERIFICATION_REQUIRED"),
        ]:
            with patch.object(worker, "emit") as emit:
                worker.report_error(error)
                emit.assert_called_once_with("error", message=str(error), code=code)

    def test_publishing_requires_verified_matching_finder(self):
        result = {"status": "logged_in", "id": "fixture"}
        worker.require_account(result, "fixture")
        for value, code in [
            (result, "ACCOUNT_MISMATCH"),
            ({"status": "logged_out"}, "LOGIN_REQUIRED"),
            ({"status": "unknown"}, "EXECUTION_FAILED"),
        ]:
            with self.assertRaises(worker.JobError) as raised:
                worker.require_account(value, "different")
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(raised.exception.stage, "preflight")

    async def test_submit_requires_host_acknowledgment(self):
        uploader = worker.ChromeVideo("示例", "file.mp4", [], 0, "unused")
        uploader.account_probe = "()=>({})"
        uploader.expected_account = "fixture"
        uploader.commands = asyncio.Queue()
        for value in [False, True]:
            uploader.commands.put_nowait({"ok": value})
        page = object()
        with patch.object(worker, "read_account", AsyncMock(return_value={"status": "logged_in", "id": "fixture"})), patch.object(worker, "emit") as emit, patch.object(worker.TencentVideo, "submit_publish", new_callable=AsyncMock) as submit:
            with self.assertRaises(RuntimeError):
                await uploader.submit_publish(page)
            submit.assert_not_awaited()
            await uploader.submit_publish(page)
            submit.assert_awaited_once_with(page)
            emit.assert_called_with("beforeSubmit")

    async def test_no_submission_after_user_switches_chrome_account(self):
        uploader = worker.ChromeVideo("示例", "file.mp4", [], 0, "unused")
        uploader.expected_account, uploader.account_probe = "fixture", "()=>({})"
        with patch.object(worker, "read_account", AsyncMock(return_value={"status": "logged_in", "id": "other"})), patch.object(worker, "emit") as emit:
            with self.assertRaises(worker.JobError) as failure:
                await uploader.submit_publish(object())
            self.assertEqual(failure.exception.stage, "beforeSubmit")
            emit.assert_not_called()
