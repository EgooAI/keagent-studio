export async function request<T>(method: string, input?: unknown): Promise<T> {
  if (!window.desktop) throw new Error("请在桌面客户端使用本机全景工作流");
  return (await window.desktop.request(
    `panorama.${method}`,
    input === undefined ? [] : [input],
  )) as T;
}
export const stageNames = {
  tts: "生成分段配音",
  avatar: "火山数字人开场",
  render: "渲染全景与合成",
  cover: "成片校验与封面",
};
export const statusNames = {
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};
