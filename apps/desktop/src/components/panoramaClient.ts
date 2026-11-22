export async function request<T>(method: string, input?: unknown): Promise<T> {
  if (!window.desktop) throw new Error("请在桌面客户端制作视频");
  return (await window.desktop.request(
    `panorama.${method}`,
    input === undefined ? [] : [input],
  )) as T;
}
export const stageNames = {
  images: "正在处理房源图片",
  tts: "生成分段配音",
  avatar: "旧版开场",
  opening: "旧版开场",
  render: "渲染镜头与合成",
  cover: "成片校验与封面",
};
export const statusNames = {
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};
