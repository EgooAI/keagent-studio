import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
} from "antd";
import type {
  PanoramaCapabilities,
  PanoramaConfig,
  PanoramaProperty,
  PanoramaScene,
  PanoramaState,
} from "@keagent/shared-types";
import { request } from "./panoramaClient";

export interface ProductionSourceSet {
  property: PanoramaProperty;
  scenes: PanoramaScene[];
  materialMode: "panorama" | "expand";
  panoramaAvailability?: string;
}

export function PanoramaSources({
  caps,
  property,
  scenes,
  tasks,
  act,
  onLoaded,
  onPhotos,
  onExpanded,
}: {
  caps: PanoramaCapabilities;
  property?: PanoramaProperty;
  scenes: PanoramaScene[];
  tasks: NonNullable<PanoramaState["imageTasks"]>;
  act: (action: () => Promise<void>) => Promise<void>;
  onLoaded: (value: ProductionSourceSet) => void;
  onPhotos: (
    value: PanoramaScene[],
    mode: PanoramaConfig["materialMode"],
  ) => void;
  onExpanded: (results: { sceneId: string; result?: PanoramaScene }[]) => void;
}) {
  const [cityName, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [address, setAddress] = useState("");
  const [prompt, setPrompt] = useState(
    "延展原图边缘的室内环境，延续原有墙面、地面、光照和透视，保留原有主体与水印，不添加门窗、家具或人物。",
  );
  const [scales, setScales] = useState({
    top_scale: 1,
    bottom_scale: 1,
    left_scale: 1.5,
    right_scale: 1.5,
  });
  const remaining = scenes.filter(
    (scene) =>
      scene.kind === "photo" && !tasks.some((t) => t.sceneId === scene.id),
  );
  const currentTasks = tasks.filter((t) =>
    scenes.some((scene) => scene.id === t.sceneId),
  );
  const onExpandedRef = useRef(onExpanded);
  onExpandedRef.current = onExpanded;
  const [refreshError, setRefreshError] = useState("");
  const pendingKey = currentTasks
    .filter(
      (t) =>
        ["PENDING", "RUNNING", "submitting"].includes(t.status) && !t.error,
    )
    .map((t) => t.id)
    .join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let stopped = false;
    let running = false;
    const timer = window.setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const results =
          await request<{ sceneId: string; result?: PanoramaScene }[]>(
            "image-refresh",
          );
        if (!stopped) {
          setRefreshError("");
          onExpandedRef.current(results);
        }
      } catch (error) {
        if (!stopped)
          setRefreshError(
            error instanceof Error ? error.message : "扩图查询失败，请手动刷新",
          );
      } finally {
        running = false;
      }
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pendingKey]);
  return (
    <>
      <Collapse
        items={[
          {
            key: "beike",
            label: "从贝壳开放平台获取房屋素材",
            children: (
              <>
                <p>
                  按已授权的详细地址查询房屋档案与素材。优先使用返回的全景原图；只返回普通照片时进入
                  AI 扩图。
                </p>
                <div className="panorama-form-grid">
                  <Form.Item label="城市">
                    <Input
                      value={cityName}
                      maxLength={80}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="例如：北京市"
                    />
                  </Form.Item>
                  <Form.Item label="区县">
                    <Input
                      value={district}
                      maxLength={80}
                      onChange={(e) => setDistrict(e.target.value)}
                    />
                  </Form.Item>
                </div>
                <Form.Item label="详细地址">
                  <Input
                    value={address}
                    maxLength={300}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </Form.Item>
                {!caps.beike && (
                  <Alert
                    type="info"
                    title="贝壳待配置"
                    description="服务端需要 BEIKE_ACCESS_TOKEN，以及数据验真和图片验真接口权限。"
                  />
                )}
                <Popconfirm
                  title="获取并载入这套房屋素材？"
                  description="会替换当前编辑区，已保存草稿保留。贝壳查询按开通服务可能计费。"
                  onConfirm={() =>
                    act(async () =>
                      onLoaded(
                        await request<ProductionSourceSet>("beike-import", {
                          cityName,
                          district,
                          address,
                        }),
                      ),
                    )
                  }
                >
                  <Button
                    disabled={
                      !caps.beike ||
                      !cityName.trim() ||
                      !district.trim() ||
                      !address.trim()
                    }
                  >
                    获取房屋素材
                  </Button>
                </Popconfirm>
              </>
            ),
          },
        ]}
      />
      <Space wrap>
        <Popconfirm
          title="载入待扩图照片？"
          description="会替换当前编辑区；原始普通照片不能直接制作视频。"
          onConfirm={() =>
            act(async () => {
              const added = await request<PanoramaScene[]>("import", {
                kind: "photo",
              });
              if (added.length) onPhotos(added, "expand");
            })
          }
        >
          <Button disabled={!property}>导入待扩图照片</Button>
        </Popconfirm>
        {property?.id.startsWith("beike-") && (
          <Button
            onClick={() =>
              void act(async () =>
                onLoaded(
                  await request<ProductionSourceSet>("source-restore", {
                    propertyId: property.id,
                  }),
                ),
              )
            }
          >
            恢复已获取的素材
          </Button>
        )}
      </Space>
      {scenes.some((s) => s.kind === "photo" || s.kind === "expanded") && (
        <>
          <Alert
            type="info"
            showIcon
            title="普通照片 → AI 扩图 → 审核 → 视频"
            description="当前贝壳图片验真接口不提供全景原图。扩图使用万相；扩出的区域为 AI 推测，不代表真实房屋全景，成片保留 AI 示意标记。"
          />
          {!caps.imageExpansion && (
            <Alert
              type="warning"
              title="扩图服务待配置"
              description="请在服务端填写 DASHSCOPE_API_KEY（百炼北京地域），重启后再测试。"
            />
          )}
          <Form.Item label="扩图说明">
            <Input.TextArea
              value={prompt}
              maxLength={600}
              onChange={(e) => setPrompt(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
          </Form.Item>
          <div className="panorama-form-grid">
            {(
              [
                "top_scale",
                "bottom_scale",
                "left_scale",
                "right_scale",
              ] as const
            ).map((key, index) => (
              <Form.Item
                key={key}
                label={["向上扩展", "向下扩展", "向左扩展", "向右扩展"][index]}
              >
                <InputNumber
                  min={1}
                  max={2}
                  step={0.1}
                  value={scales[key]}
                  onChange={(value) =>
                    setScales((previous) => ({
                      ...previous,
                      [key]: value ?? 1,
                    }))
                  }
                />
              </Form.Item>
            ))}
          </div>
          <Space wrap>
            <Popconfirm
              title={`提交 ${remaining.length} 张照片扩图？`}
              description="此操作会调用百炼并可能计费。已有任务不会重复提交。"
              onConfirm={() =>
                act(async () => {
                  for (const scene of remaining)
                    await request("image-submit", { scene, prompt, ...scales });
                })
              }
            >
              <Button
                disabled={
                  !caps.imageExpansion || !remaining.length || !prompt.trim()
                }
              >
                生成 AI 扩图
              </Button>
            </Popconfirm>
            <Button
              disabled={!currentTasks.length}
              onClick={() =>
                void act(async () =>
                  onExpanded(
                    await request<
                      { sceneId: string; result?: PanoramaScene }[]
                    >("image-refresh"),
                  ),
                )
              }
            >
              刷新扩图结果
            </Button>
          </Space>
          {currentTasks.map((task) => (
            <p key={task.id} role="status">
              {scenes.find((s) => s.id === task.sceneId)?.room}：{task.status}
              {task.error ? ` · ${task.error}` : ""}
            </p>
          ))}
          {refreshError && (
            <Alert
              type="warning"
              title="扩图查询失败"
              description={refreshError}
            />
          )}
        </>
      )}
    </>
  );
}
