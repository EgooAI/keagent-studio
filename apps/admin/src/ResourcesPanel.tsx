import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Plus } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import type { Resource, ResourceType, VideoMode } from "@keagent/shared-types";
import type { ProductionTemplatePreview } from "@keagent/shared-types";
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
  | "name"
  | "description"
  | "category"
  | "version"
  | "type"
  | "compatibleModes"
  | "production"
>;
const resourceState = (r: Resource) =>
  r.published ? "已上架" : r.publishedOnce ? "已下架" : "草稿";

export default function ResourcesPanel() {
  const { modal } = App.useApp();
  const { params, setParams } = useAdminParams();
  const query = useAdminList("resources");
  const { busy, run } = useAdminAction();
  const [form] = Form.useForm<Values>();
  const type = Form.useWatch("type", form);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [preview, setPreview] = useState<ProductionTemplatePreview>();
  const [editor, setEditor] = useState<{
    source?: Resource;
    clone: boolean;
  } | null>(null);
  const [detail, setDetail] = useState<Resource | null>(null);
  function showEditor(source?: Resource, clone = false) {
    setEditor({ source, clone });
    form.resetFields();
    form.setFieldsValue(
      source
        ? {
            name: source.name,
            description: source.description,
            category: source.category,
            version: clone ? "" : source.version,
            type: source.type,
            compatibleModes: source.compatibleModes,
            production: structuredClone(source.production || defaultProduction),
          }
        : {
            name: "",
            description: "",
            category: "通用",
            version: "1.0.0",
            type: "video",
            compatibleModes: ["voiceover", "avatar"],
            production: structuredClone(defaultProduction),
          },
    );
  }
  async function save(values: Values) {
    if (!editor) return;
    const source = editor.source;
    const saved = await run(
      () =>
        serviceRequest("/v1/admin/resources", {
          ...values,
          production: values.type === "video" ? values.production : undefined,
          compatibleModes:
            values.type === "video"
              ? [values.production!.config.videoMode]
              : values.compatibleModes,
          ...(source && !editor.clone ? { id: source.id } : {}),
          name: values.name.trim(),
          category: values.category.trim(),
          version: values.version.trim(),
          thumbnail: source?.thumbnail || "",
          sizeMb: source?.sizeMb || 0,
          published: false,
        }),
      "模板草稿已保存",
    );
    if (saved) setEditor(null);
  }
  async function showPreview(resource: Resource) {
    await run(async () => {
      const result = await serviceRequest<ProductionTemplatePreview>(
        "/v1/admin/resources/preview",
        { id: resource.id },
      );
      setPreview(result);
    }, "模板规则校验通过");
  }
  function toggle(resource: Resource) {
    modal.confirm({
      title: resource.published ? "下架这个模板版本？" : "上架这个模板版本？",
      content: (
        <>
          <p>
            {resource.name} · {resource.version}
          </p>
          <p>
            {resource.published
              ? "下架后，用户不能再为新任务选择此版本；已有任务的引用保留。"
              : "上架后用户可以选择此版本，内容将锁定；后续调整需新建版本。"}
          </p>
        </>
      ),
      okText: resource.published ? "确认下架" : "确认上架",
      cancelText: "取消",
      onOk: async () => {
        const saved = await run(
          () =>
            serviceRequest("/v1/admin/resources", {
              ...resource,
              published: !resource.published,
            }),
          resource.published ? "模板已下架" : "模板已上架",
        );
        if (!saved) throw new Error("保存失败，请重试");
      },
    });
  }
  return (
    <>
      <Alert
        className="admin-notice"
        type="info"
        showIcon
        title="完整视频模板与 AI 视频工厂同步"
        description="含制作规则的视频模板，经预览校验并上架后，用户即可选择。文案、镜头、字幕和封面配置会真实用于制作。旧版仅有目录说明的条目不会进入新版视频工厂。"
      />
      <section className="admin-panel" aria-label="模板目录">
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
              aria-label="模板类型"
              value={params.get("type") || ""}
              style={{ width: 160 }}
              onChange={(type) => setParams({ type })}
              options={[
                { value: "", label: "全部类型" },
                ...Object.entries(resourceTypeLabels).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
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
            <Button
              type="primary"
              icon={<Plus size={16} />}
              onClick={() => showEditor()}
            >
              新建模板草稿
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
            action={<Button onClick={() => void query.refetch()}>重试</Button>}
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
                    onClick={() => setDetail(r)}
                  >
                    {r.name}
                  </Button>
                  <p className="admin-secondary">
                    {r.category || "未分类"} ·{" "}
                    {r.production ? "制作模板" : "旧版目录"}
                  </p>
                </>
              ),
            },
            {
              title: "类型",
              dataIndex: "type",
              render: (type: ResourceType) =>
                resourceTypeLabels[type] || "其他模板",
            },
            { title: "版本", dataIndex: "version" },
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
              render: (_, r) => (
                <Tag color={r.published ? "green" : "default"}>
                  {resourceState(r)}
                </Tag>
              ),
            },
            {
              title: "操作",
              key: "actions",
              width: 260,
              render: (_, r) => (
                <Space wrap>
                  {r.production && (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => void showPreview(r)}
                    >
                      预览校验
                    </Button>
                  )}
                  {!r.published && !r.publishedOnce && (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => showEditor(r)}
                    >
                      编辑草稿
                    </Button>
                  )}
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => showEditor(r, true)}
                  >
                    复制新版本
                  </Button>
                  <Button
                    size="small"
                    disabled={
                      busy || (!!r.production && !r.previewed && !r.published)
                    }
                    title={
                      r.production && !r.previewed && !r.published
                        ? "请先预览校验"
                        : undefined
                    }
                    aria-label={r.published ? "下架" : "上架"}
                    onClick={() => toggle(r)}
                  >
                    {r.published ? "下架" : "上架"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </section>
      <Drawer
        title="模板详情"
        open={!!detail}
        onClose={() => setDetail(null)}
        width={560}
      >
        {detail && (
          <>
            <h2>{detail.name}</h2>
            <Descriptions
              bordered
              column={1}
              items={[
                {
                  key: "type",
                  label: "类型",
                  children: resourceTypeLabels[detail.type],
                },
                { key: "version", label: "版本", children: detail.version },
                {
                  key: "category",
                  label: "分类",
                  children: detail.category || "未分类",
                },
                {
                  key: "state",
                  label: "状态",
                  children: resourceState(detail),
                },
                {
                  key: "modes",
                  label: "适用模式",
                  children: detail.compatibleModes
                    .map((m) => modeLabels[m])
                    .join("、"),
                },
                {
                  key: "description",
                  label: "适用说明",
                  children: (
                    <div className="admin-prewrap">
                      {detail.description || "暂无说明"}
                    </div>
                  ),
                },
                {
                  key: "id",
                  label: "内部编号",
                  children: (
                    <Typography.Text copyable>{detail.id}</Typography.Text>
                  ),
                },
              ]}
            />
            <p className="admin-secondary">
              发布过的版本内容不可修改。需要调整时，请复制为新版本。
            </p>
            {detail.production && (
              <Button onClick={() => void showPreview(detail)} disabled={busy}>
                查看制作规则与预览
              </Button>
            )}
          </>
        )}
      </Drawer>
      <Modal
        title={
          editor?.clone
            ? "复制为新版本草稿"
            : editor?.source
              ? "编辑模板草稿"
              : "新建模板草稿"
        }
        open={!!editor}
        onCancel={() => {
          if (!busy) setEditor(null);
        }}
        onOk={() => form.submit()}
        okText="保存草稿"
        cancelText="取消"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        destroyOnHidden
        width={760}
      >
        {editor?.clone && (
          <Alert
            className="admin-notice"
            type="info"
            title={`来源：${editor.source?.name} · ${editor.source?.version}。请填写不同的版本号。`}
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void save(values)}
          disabled={busy}
        >
          <Form.Item
            name="name"
            label="模板名称"
            rules={[{ required: true, whitespace: true, max: 120 }]}
          >
            <Input maxLength={120} />
          </Form.Item>
          <div className="admin-form-columns">
            <Form.Item
              name="type"
              label="模板类型"
              rules={[{ required: true }]}
            >
              <Select
                options={Object.entries(resourceTypeLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item
              name="category"
              label="分类"
              rules={[{ required: true, whitespace: true, max: 80 }]}
            >
              <Input maxLength={80} />
            </Form.Item>
          </div>
          <Form.Item
            name="version"
            label="版本号"
            rules={[
              { required: true, whitespace: true, max: 40 },
              {
                pattern:
                  type === "video"
                    ? /^[1-9][0-9]{0,3}\.[0-9]{1,4}\.[0-9]{1,4}$/
                    : undefined,
                message: "制作模板请使用 1.0.0 格式的版本号",
              },
              {
                validator: (_, value: string) =>
                  editor?.clone && value?.trim() === editor.source?.version
                    ? Promise.reject(new Error("新版本号不能与来源版本相同"))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="例如 1.0.0" maxLength={40} />
          </Form.Item>
          {type !== "video" && (
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
          {type === "video" && <ProductionTemplateEditor />}
        </Form>
      </Modal>
      <Drawer
        title="视频模板添加规则"
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        width={640}
      >
        <ProductionTemplateRules />
      </Drawer>
      <Drawer
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
