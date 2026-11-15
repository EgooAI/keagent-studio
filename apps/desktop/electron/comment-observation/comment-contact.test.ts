import { expect, it } from "vitest";
import { publicCommenterProfile } from "./comment-contact";

it("accepts only a public profile on the selected platform", () => {
  const douyin = "https://www.douyin.com/user/MS4wLjAB";
  const xhs = "https://www.xiaohongshu.com/user/profile/" + "a".repeat(24);
  expect(publicCommenterProfile(douyin + "/", "douyin")).toBe(douyin);
  expect(publicCommenterProfile(xhs, "xhs")).toBe(xhs);
  expect(() => publicCommenterProfile(xhs, "douyin")).toThrow();
  expect(() => publicCommenterProfile(douyin, "xhs")).toThrow();
  for (const url of [
    xhs.replace(".com/", ".com.example/"),
    xhs + "?target=elsewhere",
    xhs + "/settings",
    xhs.slice(0, -1),
  ])
    expect(() => publicCommenterProfile(url, "xhs")).toThrow();
});
