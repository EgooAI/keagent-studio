import { useState } from "react";
import { Alert, App, Button, Image, Space } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "./panoramaClient";

type Materials = {
  photo?: { name: string; url: string };
  background?: { name: string; url: string };
};

export function OpeningMaterials() {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const materials = useQuery({
    queryKey: ["opening-materials"],
    queryFn: () => request<Materials>("opening-materials"),
    enabled: !!window.desktop,
  });
  async function upload(kind: "photo" | "background") {
    setBusy(true);
    try {
      const saved = await request(`opening-${kind}-import`);
      if (!saved) return;
      await Promise.all([
        client.invalidateQueries({ queryKey: ["opening-materials"] }),
        client.invalidateQueries({ queryKey: ["factory-catalog"] }),
      ]);
      message.success("素材已保存，新建视频将使用这张图片");
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "上传失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>形象与背景</h2>
      <p className="muted">
        MiniMax
        将经纪人照片、开场背景图、模板提示词和生成的配音组合成露脸开场。人物在背景场景中边走边介绍。
      </p>
      {!window.desktop && (
        <Alert type="info" showIcon title="请在桌面客户端上传开场素材" />
      )}
      {materials.error && (
        <Alert
          type="error"
          showIcon
          title="素材读取失败"
          description={materials.error.message}
          action={
            <Button onClick={() => void materials.refetch()}>重试</Button>
          }
        />
      )}
      {(["photo", "background"] as const).map((kind) => {
        const item = materials.data?.[kind];
        const label = kind === "photo" ? "经纪人照片" : "开场背景图";
        return (
          <section key={kind} style={{ marginTop: 28 }} aria-label={label}>
            <h3>{label}</h3>
            <p className="muted">
              {kind === "photo"
                ? "上传清晰的本人正面照片，脸部无遮挡，最多 3 MB。"
                : "上传希望人物出镜的场景，例如小区入口、园区步道或室内，最多 15 MB。"}
              支持 JPG / PNG，宽高 256–4096 像素，宽高比 0.4–2.5。
            </p>
            <Space align="start" wrap size={16}>
              {item && (
                <Image
                  width={180}
                  height={120}
                  style={{ objectFit: "contain" }}
                  src={item.url}
                  alt={label}
                />
              )}
              <div>
                <p>{item?.name || "尚未上传"}</p>
                <Button
                  disabled={!window.desktop || busy || materials.isFetching}
                  onClick={() => void upload(kind)}
                >
                  {item ? "更换" : "上传"}
                  {label}
                </Button>
              </div>
            </Space>
          </section>
        );
      })}
      <p className="muted" style={{ marginTop: 28 }}>
        图片保存在本机当前账号下，替换后用于新任务。请上传有权使用的素材，制作前确认授权后，图片与配音会发送给
        MiniMax。
      </p>
    </div>
  );
}
