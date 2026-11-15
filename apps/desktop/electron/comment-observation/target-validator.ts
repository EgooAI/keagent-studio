import { PublishingError } from "../publishing/core";

export function standardTarget(input: unknown) {
  const value = typeof input === "string" ? input.trim() : "";
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    !url ||
    url.origin !== "https://www.douyin.com" ||
    url.username ||
    url.password ||
    /[\s\\]/.test(value)
  )
    throw new PublishingError(
      "INVALID_TARGET",
      "请复制抖音作品详情页地址，或在作者主页、精选页点开作品后复制地址。短链接和分享文案请先在浏览器打开。",
      422,
    );
  const directId = /^\/video\/(\d{5,30})\/?$/.exec(url.pathname)?.[1];
  const modalIds = url.searchParams.getAll("modal_id");
  if (
    modalIds.length > 1 ||
    (directId && modalIds.length && modalIds[0] !== directId)
  )
    throw new PublishingError(
      "INVALID_TARGET",
      "地址中的弹层作品与路径作品不一致。请打开目标作品的独立详情页后再复制地址。",
      422,
    );
  const id =
    directId ??
    (/^\/(?:user\/[\w-]+|jingxuan)\/?$/.test(url.pathname)
      ? modalIds[0]
      : undefined);
  if (!id || !/^\d{5,30}$/.test(id))
    throw new PublishingError(
      "INVALID_TARGET",
      "此地址没有可确认的作品 ID。请点开具体作品，再复制浏览器地址。",
      422,
    );
  return { inputWorkId: id, targetUrl: "https://www.douyin.com/video/" + id };
}
