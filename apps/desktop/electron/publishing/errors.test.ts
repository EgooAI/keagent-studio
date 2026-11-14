import { describe, expect, it } from "vitest";
import { PublishingError } from "./core";
import { desktopErrorMessage, GENERIC_DESKTOP_ERROR } from "./errors";

describe("desktopErrorMessage", () => {
  it("keeps actionable Go error messages", () => {
    for (const code of [
      "COMMENT_AI_UNAVAILABLE",
      "COMMENT_PROFILE_UNAVAILABLE",
      "COMMENT_CHANGED",
      "CONSENT_REQUIRED",
      "CONSENT_REVOKED",
      "COMMENT_PURPOSE_DENIED",
      "COMMENT_NOT_QUALIFIED",
      "ACCOUNT_UNAVAILABLE",
      "ACCOUNT_CHANGED",
      "INVALID_INPUT",
      "OUTREACH_EXISTS",
      "CREATORHUB_REJECTED",
    ]) {
      const error = Object.assign(new Error(`可操作错误 ${code}`), { code });
      expect(desktopErrorMessage(error)).toBe(`可操作错误 ${code}`);
    }
  });

  it("keeps PublishingError messages", () => {
    expect(
      desktopErrorMessage(
        new PublishingError("SOMETHING_ELSE", "发布队列已暂停", 409),
      ),
    ).toBe("发布队列已暂停");
  });

  it("uses the generic text for unknown failures and empty messages", () => {
    expect(desktopErrorMessage(new Error("socket hang up"))).toBe(
      GENERIC_DESKTOP_ERROR,
    );
    expect(
      desktopErrorMessage(
        Object.assign(new Error("internal"), { code: "UNKNOWN_CODE" }),
      ),
    ).toBe(GENERIC_DESKTOP_ERROR);
    expect(
      desktopErrorMessage(
        Object.assign(new Error(""), { code: "CREATORHUB_REJECTED" }),
      ),
    ).toBe(GENERIC_DESKTOP_ERROR);
  });
});
