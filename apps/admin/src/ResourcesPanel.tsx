import { useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from "antd";
import { Plus, Search, UploadCloud } from "lucide-react";
import { demoApi } from "@keagent/api-client";
import type { Resource, ResourceType } from "@keagent/shared-types";

const typeLabels: Record<ResourceType, string> = {
  video: "视频模板",
  style: "风格模板",
  cover: "封面模板",
  subtitle: "字幕模板",
  prompt: "提示词模板",
};
interface Values {
  name: string;
  type: ResourceType;
  category: string;
  version: string;
  description: string;
}

export default function ResourcesPanel({
  resources,
  onAudit,
}: {
  resources: Resource[];
  onAudit: (action: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<Values>();
  function show(resource?: Resource) {
    setEditing(resource ?? null);
    setFile(null);
    form.setFieldsValue(
      resource ?? {
        name: "",
        type: "video",
        category: "简约专业",
        version: "1.0.0",
        description: "",
      },
    );
    setOpen(true);
  }
  async function submit() {
    setBusy(true);
    try {
      const values = await form.validateFields();
      if (editing)
        await demoApi.updateResource(editing.id, {
          name: values.name,
          description: values.description,
          category: values.category,
        });
      else {
        if (!file && values.type !== "prompt") {
          message.warning("请选择演示资源包文件");
          return;
        }
        await demoApi.createResource({
          ...values,
          published: false,
          installed: false,
          sizeMb: file
            ? Math.max(0.1, Number((file.size / 1024 / 1024).toFixed(1)))
            : 0.1,
          thumbnail: "/media/interior-1.jpg",
          compatibleModes: ["voiceover", "avatar"],
        });
      }
      onAudit(`${editing ? "编辑" : "创建"}资源草稿：${values.name}`);
      setOpen(false);
      message.success("模拟资源草稿已保存");
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(resource: Resource) {
    try {
      await demoApi.updateResource(resource.id, {
        published: !resource.published,
      });
      onAudit(
        `${resource.published ? "下架" : "发布"}资源：${resource.name} ${resource.version}`,
      );
      message.success(resource.published ? "资源已模拟下架" : "资源已模拟发布");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    }
  }
  const filtered = resources.filter(
    (resource) =>
      (type === "all" || resource.type === type) &&
      `${resource.name}${resource.category}`.includes(search),
  );
  return (
    <>
      <div className="admin-toolbar">
        <Space>
          <Input
            prefix={<Search size={15} />}
            placeholder="搜索资源名称或分类"
            aria-label="搜索资源"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            allowClear
          />
          <Select
            aria-label="资源类型"
            value={type}
            onChange={setType}
            style={{ width: 150 }}
            options={[
              { value: "all", label: "全部资源" },
              ...Object.entries(typeLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </Space>
        <Button type="primary" icon={<Plus size={15} />} onClick={() => show()}>
          上传资源包
        </Button>
      </div>
      <Alert
        type="info"
        title="仅模拟资源目录与安装状态；选择的文件不会上传。已发布版本的内容不可覆盖，下架后仍需创建新资源版本。"
        style={{ marginBottom: 18 }}
      />
      <Table<Resource>
        rowKey="id"
        dataSource={filtered}
        pagination={{ pageSize: 8, showSizeChanger: false }}
        scroll={{ x: 850 }}
        columns={[
          {
            title: "资源",
            key: "name",
            render: (_, resource) => (
              <Space>
                <img
                  src={resource.thumbnail}
                  alt=""
                  className="admin-resource-thumb"
                />
                <div>
                  <strong>{resource.name}</strong>
                  <p className="admin-secondary">{resource.category}</p>
                </div>
              </Space>
            ),
          },
          {
            title: "类型",
            dataIndex: "type",
            render: (value: ResourceType) => typeLabels[value],
          },
          { title: "版本", dataIndex: "version" },
          {
            title: "兼容模式",
            key: "modes",
            render: (_, resource) =>
              resource.compatibleModes
                .map((mode) => (mode === "avatar" ? "露脸" : "口播"))
                .join(" / "),
          },
          {
            title: "状态",
            dataIndex: "published",
            render: (value: boolean) => (
              <Tag color={value ? "green" : "default"}>
                {value ? "已发布" : "草稿 / 已下架"}
              </Tag>
            ),
          },
          {
            title: "操作",
            key: "actions",
            render: (_, resource) => (
              <Space>
                <Button
                  type="link"
                  size="small"
                  disabled={resource.published || resource.publishedOnce}
                  title={
                    resource.published || resource.publishedOnce
                      ? "已发布版本内容不可覆盖，请创建新资源版本"
                      : "编辑未发布草稿"
                  }
                  onClick={() => show(resource)}
                >
                  编辑
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger={resource.published}
                  onClick={() => void toggle(resource)}
                >
                  {resource.published ? "下架" : "发布"}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? "编辑资源草稿" : "上传演示资源包"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        confirmLoading={busy}
        okText="保存草稿"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="资源名称"
            rules={[{ required: true, message: "请输入名称" }, { max: 60 }]}
          >
            <Input />
          </Form.Item>
          <div className="admin-form-columns">
            <Form.Item
              name="type"
              label="资源类型"
              rules={[{ required: true }]}
            >
              <Select
                disabled={!!editing}
                options={Object.entries(typeLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="version"
              label="资源版本"
              rules={[
                { required: true, message: "请输入版本" },
                { pattern: /^\d+\.\d+\.\d+$/, message: "版本格式为 1.0.0" },
              ]}
            >
              <Input disabled={!!editing} />
            </Form.Item>
          </div>
          <Form.Item
            name="category"
            label="分类"
            rules={[{ required: true, message: "请输入分类" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="效果与使用说明">
            <Input.TextArea rows={3} maxLength={500} />
          </Form.Item>
          {!editing && (
            <Form.Item label="资源文件">
              <Upload
                showUploadList={false}
                accept=".zip,.json,.ttf,.otf"
                beforeUpload={(selected) => {
                  if (selected.size > 100 * 1024 * 1024) {
                    message.error("演示文件不能超过 100 MB");
                    return false;
                  }
                  setFile({ name: selected.name, size: selected.size });
                  return false;
                }}
              >
                <Button icon={<UploadCloud size={16} />}>
                  {file?.name ?? "选择文件（仅演示）"}
                </Button>
              </Upload>
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
