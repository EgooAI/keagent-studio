import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import type { Resource, ResourceType, VideoMode } from "@keagent/shared-types";
import type {
  ProductionTemplatePreview,
  ProductionTemplateRecipe,
} from "@keagent/shared-types";
import {
  defaultProduction,
  ProductionTemplateEditor,
  ProductionPreview,
  ProductionTemplateRules,
} from "./ProductionTemplateEditor";
import {
  listPagination,
  useAdminAction,
  useAdminList,
  useAdminParams,
} from "./admin-api";

export const resourceTypeLabels: Record<ResourceType, string> = {
  video: "视频模板",
  style: "风格模板",
  cover: "封面模板",
  subtitle: "字幕模板",
  prompt: "文案提示词模板",
};
const modeLabels: Record<VideoMode, string> = {
  voiceover: "纯口播",
  avatar: "经纪人露脸",
};
type Values = Pick<
  Resource,
  "name" | "description" | "category" | "version"
> & { production: ProductionTemplateRecipe };
const resourceState = (r: Resource) =>
  r.published ? "已上架" : r.publishedOnce ? "已下架" : "草稿";
const isLocked = (r: Resource) => r.published || !!r.publishedOnce;

export default function ResourcesPanel() {
  const { modal } = App.useApp();
  const { params, setParams } = useAdminParams();
  const query = useAdminList("resources");
  const { busy, run } = useAdminAction();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [preview, setPreview] = useState<ProductionTemplatePreview>();
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const templateId = params.get("templateId");
  const versionId = params.get("versionId");
  const updating = params.get("update") === "1";
  const history = useQuery({
    queryKey: ["admin", "resource-versions", templateId],
    enabled: !!templateId,
    queryFn: () =>
      serviceRequest<Resource[]>(
        `/v1/admin/resources/versions?id=${encodeURIComponent(templateId!)}`,
      ),
  });
  const versions = history.data || [];
  const enabled = versions.filter((version) => version.published);
  const draft = updating && versions.find((version) => !isLocked(version));
  const selected =
    draft ||
    versions.find((version) => version.id === (versionId || templateId)) ||
    versions[0];
  const newVersion = updating && !!selected && isLocked(selected);
  const readOnly = !!selected && isLocked(selected) && !newVersion;

  function navigateEditor(patch: Record<string, string | undefined>) {
    const navigate = () => {
      setDirty(false);
      setParams(patch, false);
    };
    if (dirty) {
      modal.confirm({
        title: "放弃未保存的更改？",
        okText: "放弃更改",
        cancelText: "继续编辑",
        onOk: navigate,
      });
    } else navigate();
  }
  function openEditor(resource: Resource, update = false) {
    navigateEditor({
      templateId: resource.id,
      versionId: undefined,
      update: update ? "1" : undefined,
    });
  }
  async function save(
    values: Values,
    source?: Resource,
    createVersion = false,
  ) {
    let savedId: string | undefined;
    const saved = await run(async () => {
      const result = await serviceRequest<{ id: string }>(
        "/v1/admin/resources",
        {
          ...values,
          type: "video",
          compatibleModes: [values.production.config.videoMode],
          ...(source && !createVersion
            ? { id: source.id }
            : { versionOf: source?.id, published: false }),
          name: values.name.trim(),
          category: values.category.trim(),
          version: values.version.trim(),
          thumbnail: source?.thumbnail || "",
          sizeMb: source?.sizeMb || 0,
        },
      );
      savedId = result.id;
    }, "模板草稿已保存");
    if (!saved) return;
    setDirty(false);
    if (source) {
      setParams({ versionId: savedId, update: undefined }, false);
    } else setCreating(false);
  }
  async function showPreview(resource: Resource) {
    await run(async () => {
      if (resource.previewed) {
        const cached = await serviceRequest<ProductionTemplatePreview | null>(
          `/v1/admin/resources/preview?id=${encodeURIComponent(resource.id)}`,
        );
        if (cached) {
          setPreview(cached);
          return;
        }
      }
      const images =
        resource.production?.schemaVersion === 2
          ? await Promise.all(
              [1, 2].map(async (index) => {
                const response = await fetch(`/media/interior-${index}.jpg`);
                if (!response.ok) throw new Error("无法读取模板预览图片");
                const blob = await response.blob();
                const jpeg = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve(String(reader.result).split(",")[1]);
                  reader.onerror = () =>
                    reject(new Error("无法读取模板预览图片"));
                  reader.readAsDataURL(blob);
                });
                return {
                  id: `preview-${index}`,
                  kind: "photo",
                  room: `图片 ${index}`,
                  jpeg,
                };
              }),
            )
          : undefined;
      const result = await serviceRequest<ProductionTemplatePreview>(
        "/v1/admin/resources/preview",
        { id: resource.id, images },
      );
      setPreview(result);
    }, "");
  }
  function toggle(resource: Resource, publish: boolean) {
    modal.confirm({
      title: publish ? "启用这个模板版本？" : "停用这个模板版本？",
      content: (
        <>
          <p>
            {resource.name} · {resource.version}
          </p>
          <p>
            {publish
              ? "新任务将使用此版本。同一模板的其他版本会停用，已有任务保留原版本。"
              : "停用后，新任务无法选择此版本。已有任务保留原版本。"}
          </p>
        </>
      ),
      okText: publish ? "确认启用" : "确认停用",
      cancelText: "取消",
      onOk: async () => {
        const saved = await run(
          () =>
            serviceRequest("/v1/admin/resources", {
              id: resource.id,
              published: publish,
            }),
          publish ? "模板版本已启用" : "模板版本已停用",
        );
        if (!saved) throw new Error("保存失败，请重试");
      },
    });
  }
  return (
    <>
      {templateId ? (
        <section
          className="admin-panel"
          aria-labelledby="admin-template-editor"
        >
          <div className="admin-section-heading">
            <div>
              <h2 id="admin-template-editor">{selected?.name || "模板版本"}</h2>
              {selected && (
                <p className="admin-secondary">
                  {enabled.length
                    ? `已启用版本 ${enabled.map((version) => version.version).join("、")}`
                    : "当前没有启用的版本"}
                </p>
              )}
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                navigateEditor({
                  templateId: undefined,
                  versionId: undefined,
                  update: undefined,
                })
              }
            >
              返回模板目录
            </Button>
          </div>
          {history.isPending && <Skeleton active />}
          {history.error && (
            <Alert
              type="error"
              showIcon
              title="版本记录读取失败"
              description={history.error.message}
              action={
                <Button onClick={() => void history.refetch()}>重试</Button>
              }
            />
          )}
          {selected && (
            <>
              <h3 className="admin-template-versions-heading">版本记录</h3>
              <div className="admin-toolbar admin-template-version-toolbar">
                <Space wrap>
                  <Select
                    aria-label="查看模板版本"
                    value={newVersion ? undefined : selected.id}
                    placeholder="正在编辑新版本"
                    style={{ width: 240 }}
                    virtual={false}
                    disabled={busy}
                    onChange={(id) =>
                      navigateEditor({ versionId: id, update: undefined })
                    }
                    options={versions.map((version) => ({
                      value: version.id,
                      label: `${version.version} · ${resourceState(version)}`,
                    }))}
                  />
                  {!newVersion && (
                    <Button
                      disabled={busy || dirty}
                      onClick={() => void showPreview(selected)}
                    >
                      预览校验
                    </Button>
                  )}
                </Space>
                {!newVersion && (
                  <Space wrap>
                    {readOnly && (
                      <Button
                        disabled={busy}
                        onClick={() => navigateEditor({ update: "1" })}
                      >
                        更新版本
                      </Button>
                    )}
                    {selected.published && (
                      <Button
                        disabled={busy}
                        onClick={() => toggle(selected, false)}
                      >
                        停用版本
                      </Button>
                    )}
                    {(!selected.published || enabled.length > 1) && (
                      <Button
                        type="primary"
                        disabled={busy || dirty || !selected.previewed}
                        onClick={() => toggle(selected, true)}
                      >
                        启用版本
                      </Button>
                    )}
                  </Space>
                )}
              </div>
              <h3 className="admin-template-versions-heading">
                {newVersion
                  ? "编辑新版本"
                  : readOnly
                    ? "版本内容"
                    : "编辑版本草稿"}
              </h3>
              {!newVersion && (
                <p className="admin-secondary admin-notice">
                  内部编号{" "}
                  <Typography.Text copyable>{selected.id}</Typography.Text>
                </p>
              )}
              {newVersion && (
                <p className="admin-secondary admin-notice">
                  基于 {selected.version} 版编辑。保存草稿后可预览并启用。
                </p>
              )}
              {!newVersion && !readOnly && (dirty || !selected.previewed) && (
                <p className="admin-secondary admin-notice">
                  {dirty
                    ? "保存更改后可以预览或启用此版本。"
                    : "完成预览校验后即可启用此版本。"}
                </p>
              )}
              <ResourceForm
                key={`${selected.id}:${newVersion}:${readOnly}`}
                source={selected}
                newVersion={newVersion}
                readOnly={readOnly}
                versions={versions}
                busy={busy}
                onDirty={() => setDirty(true)}
                onSave={(values) => void save(values, selected, newVersion)}
              />
            </>
          )}
        </section>
      ) : (
        <section
          className="admin-panel admin-table-panel"
          aria-labelledby="admin-template-list"
        >
          <div className="admin-section-heading">
            <div>
              <h2 id="admin-template-list">模板目录</h2>
              <p className="admin-secondary">
                完整视频模板启用后会同步到 AI
                视频工厂。点击模板名称查看版本记录。
              </p>
            </div>
            <Button
              type="primary"
              icon={<Plus size={16} />}
              onClick={() => setCreating(true)}
            >
              新建模板草稿
            </Button>
          </div>
          <div className="admin-toolbar">
            <Space wrap>
              <Input.Search
                key={params.get("q") || ""}
                defaultValue={params.get("q") || ""}
                placeholder="搜索模板名称或分类"
                aria-label="搜索模板"
                allowClear
                onSearch={(q) => setParams({ q })}
                style={{ width: 260 }}
              />
              <Select
                aria-label="上架状态"
                value={params.get("state") || ""}
                style={{ width: 130 }}
                onChange={(state) => setParams({ state })}
                options={[
                  { value: "", label: "全部状态" },
                  { value: "draft", label: "草稿" },
                  { value: "published", label: "已上架" },
                  { value: "unpublished", label: "已下架" },
                ]}
              />
            </Space>
            <Space>
              <Button onClick={() => setRulesOpen(true)}>添加规则</Button>
              <Button
                onClick={() => void query.refetch()}
                loading={query.isFetching}
              >
                刷新
              </Button>
            </Space>
          </div>
          {query.error && (
            <Alert
              className="admin-notice"
              type="error"
              showIcon
              title="模板目录读取失败"
              description={query.error.message}
              action={
                <Button onClick={() => void query.refetch()}>重试</Button>
              }
            />
          )}
          <Table<Resource>
            rowKey="id"
            loading={query.isPending && !query.error}
            dataSource={query.data?.items || []}
            scroll={{ x: 1000 }}
            pagination={listPagination(query.data, params, setParams)}
            locale={{
              emptyText: (
                <Empty description="没有符合条件的模板。可调整筛选，或新建模板草稿。" />
              ),
            }}
            columns={[
              {
                title: "模板",
                key: "name",
                render: (_, r) => (
                  <>
                    <Button
                      type="link"
                      className="admin-text-button"
                      onClick={() => openEditor(r)}
                    >
                      {r.name}
                    </Button>
                    <p className="admin-secondary">{r.category || "未分类"}</p>
                  </>
                ),
              },
              { title: "版本", dataIndex: "version", width: 100 },
              {
                title: "适用模式",
                key: "modes",
                render: (_, r) =>
                  r.compatibleModes.map((m) => modeLabels[m]).join("、") ||
                  "未设置",
              },
              {
                title: "状态",
                key: "state",
                width: 100,
                render: (_, r) => (
                  <Tag color={r.published ? "green" : "default"}>
                    {resourceState(r)}
                  </Tag>
                ),
              },
              {
                title: "操作",
                key: "actions",
                width: 205,
                render: (_, r) => (
                  <Space wrap>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => openEditor(r, true)}
                    >
                      更新版本
                    </Button>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => void showPreview(r)}
                    >
                      预览校验
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </section>
      )}
      <Modal
        title="新建模板草稿"
        open={creating}
        onCancel={() => setCreating(false)}
        okText="保存草稿"
        cancelText="取消"
        okButtonProps={{ htmlType: "submit", form: "new-template" }}
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        destroyOnHidden
        width={760}
      >
        <ResourceForm
          formId="new-template"
          busy={busy}
          onSave={(values) => void save(values)}
        />
      </Modal>
      <Drawer
        rootClassName="admin-detail-drawer"
        title="视频模板添加规则"
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        width={640}
      >
        <ProductionTemplateRules />
      </Drawer>
      <Drawer
        rootClassName="admin-detail-drawer"
        title="制作模板预览校验"
        open={!!preview}
        onClose={() => setPreview(undefined)}
        width={640}
      >
        {preview && <ProductionPreview value={preview} />}
      </Drawer>
    </>
  );
}

function ResourceForm({
  source,
  newVersion = false,
  readOnly = false,
  versions = [],
  formId,
  busy,
  onDirty,
  onSave,
}: {
  source?: Resource;
  newVersion?: boolean;
  readOnly?: boolean;
  versions?: Resource[];
  formId?: string;
  busy: boolean;
  onDirty?: () => void;
  onSave: (values: Values) => void;
}) {
  let production = source?.production || defaultProduction;
  if (!readOnly && production.schemaVersion === 1) {
    const { openingTemplate, sceneTemplate, closingTemplate, ...config } =
      production.config;
    production = {
      ...defaultProduction,
      config,
      scriptRules: {
        ...defaultProduction.scriptRules,
        opening: openingTemplate,
        scene: sceneTemplate,
        closing: closingTemplate,
      },
    };
  }
  return (
    <Form
      id={formId}
      className={readOnly ? "admin-template-readonly" : undefined}
      layout="vertical"
      initialValues={{
        name: source?.name || "",
        description: source?.description || "",
        category: source?.category || "通用",
        version: newVersion ? "" : source?.version || "1.0.0",
        compatibleModes: source?.compatibleModes,
        production,
      }}
      disabled={busy || readOnly}
      onValuesChange={onDirty}
      onFinish={onSave}
    >
      <Form.Item
        name="name"
        label="模板名称"
        rules={[{ required: true, whitespace: true, max: 120 }]}
      >
        <Input maxLength={120} />
      </Form.Item>
      <Form.Item
        name="category"
        label="分类"
        rules={[{ required: true, whitespace: true, max: 80 }]}
      >
        <Input maxLength={80} />
      </Form.Item>
      <Form.Item
        name="version"
        label="版本号"
        rules={[
          { required: true, whitespace: true, max: 40 },
          {
            pattern: /^[1-9][0-9]{0,3}\.[0-9]{1,4}\.[0-9]{1,4}$/,
            message: "制作模板请使用 1.0.0 格式的版本号",
          },
          {
            validator: (_, value: string) =>
              versions.some(
                (version) =>
                  (newVersion || version.id !== source?.id) &&
                  version.version === value?.trim(),
              )
                ? Promise.reject(new Error("此模板已使用该版本号"))
                : Promise.resolve(),
          },
        ]}
      >
        <Input placeholder="例如 1.0.0" maxLength={40} />
      </Form.Item>
      {readOnly && (
        <Form.Item
          name="compatibleModes"
          label="适用视频模式"
          rules={[
            {
              required: true,
              type: "array",
              min: 1,
              message: "至少选择一种视频模式",
            },
          ]}
        >
          <Select
            mode="multiple"
            options={Object.entries(modeLabels).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
      )}
      <Form.Item
        name="description"
        label="适用说明"
        rules={[{ max: 4000 }]}
        extra="显示给用户的适用说明。具体句式在下方制作规则中填写。"
      >
        <Input.TextArea rows={4} maxLength={4000} showCount />
      </Form.Item>
      <ProductionTemplateEditor disabled={busy || readOnly} />
      {!formId && !readOnly && (
        <Button type="primary" htmlType="submit" loading={busy}>
          保存草稿
        </Button>
      )}
    </Form>
  );
}
