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
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import type { AdminPublicVoice } from "@keagent/shared-types";
import { useAdminAction } from "./admin-api";

const publicVoiceModel = "qwen-audio-3.1-tts-plus";

export default function AdminPublicVoices() {
  const query = useQuery({
    queryKey: ["admin", "public-voices"],
    queryFn: () => serviceRequest<AdminPublicVoice[]>("/v1/admin/voices"),
  });
  const action = useAdminAction();
  const [editor, setEditor] = useState<AdminPublicVoice | "new" | null>(null);
  const [form] = Form.useForm<AdminPublicVoice>();
  function edit(voice?: AdminPublicVoice) {
    setEditor(voice || "new");
    form.setFieldsValue(
      voice || {
        id: "",
        name: "",
        speakerId: "",
        resourceId: publicVoiceModel,
        language: "zh-CN",
        enabled: false,
        publishedOnce: false,
      },
    );
  }
  async function save(values: AdminPublicVoice) {
    const saved = await action.run(
      () =>
        serviceRequest("/v1/admin/voices", {
          ...values,
          id: editor && editor !== "new" ? editor.id : "",
          enabled: editor && editor !== "new" ? editor.enabled : false,
          resourceId: publicVoiceModel,
        }),
      "公共音色已保存",
    );
    if (saved) setEditor(null);
  }
  const locked = !!editor && editor !== "new" && editor.publishedOnce;
  return (
    <>
      <section
        className="admin-panel admin-table-panel"
        aria-label="公共音色目录"
      >
        <div className="admin-section-heading">
          <div>
            <h2>公共音色目录</h2>
            <p className="admin-secondary">
              维护百炼千问 3.1 Plus 系统音色，用户可在视频创作中选择已上架项。
            </p>
          </div>
          <Space>
            <Button
              icon={<RefreshCw size={14} />}
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              刷新列表
            </Button>
            <Button
              type="primary"
              icon={<Plus size={15} />}
              onClick={() => edit()}
            >
              新增公共音色
            </Button>
          </Space>
        </div>
        <Alert
          className="admin-notice"
          type="info"
          showIcon
          title="用户只能选择已上架的公共音色或本人音色"
          description="千问 3.1 Plus 支持龙安灵心、许南川、龙安欢和龙安风悦。已上架过的音色编号和语言会保留在历史制作记录中，更换时请新增音色。"
        />
        {query.isError && (
          <Alert
            className="admin-notice"
            type="error"
            showIcon
            title="无法读取公共音色"
            description={query.error.message}
          />
        )}
        <Table<AdminPublicVoice>
          rowKey="id"
          loading={query.isPending}
          dataSource={query.data || []}
          scroll={{ x: 760 }}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (value: string) => (
                <strong style={{ fontWeight: 550 }}>{value}</strong>
              ),
            },
            {
              title: "语言",
              dataIndex: "language",
              width: 110,
              render: (value) => (
                <Tag>{value === "zh-CN" ? "普通话" : "英语"}</Tag>
              ),
            },
            {
              title: "音色编号",
              dataIndex: "speakerId",
              render: (value: string) => (
                <code className="admin-code">{value}</code>
              ),
            },
            {
              title: "合成模型",
              dataIndex: "resourceId",
              render: (value: string) => (
                <code className="admin-code">{value}</code>
              ),
            },
            {
              title: "状态",
              width: 100,
              render: (_, voice) =>
                !voice.retired && voice.resourceId === publicVoiceModel ? (
                  <Tag color={voice.enabled ? "green" : "default"}>
                    {voice.enabled ? "已上架" : "未上架"}
                  </Tag>
                ) : (
                  <Tag>已停用</Tag>
                ),
            },
            {
              title: "操作",
              align: "right",
              width: 140,
              render: (_, voice) =>
                !voice.retired &&
                voice.resourceId === publicVoiceModel && (
                  <Space className="admin-row-actions" size={4}>
                    <Button type="link" onClick={() => edit(voice)}>
                      编辑
                    </Button>
                    <Button
                      type="link"
                      danger={voice.enabled}
                      loading={action.busy}
                      onClick={() =>
                        void action.run(
                          () =>
                            serviceRequest("/v1/admin/voices", {
                              ...voice,
                              enabled: !voice.enabled,
                            }),
                          voice.enabled ? "音色已下架" : "音色已上架",
                        )
                      }
                    >
                      {voice.enabled ? "下架" : "上架"}
                    </Button>
                  </Space>
                ),
            },
          ]}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
        />
      </section>
      <Modal
        title={editor === "new" ? "新增公共音色" : "编辑公共音色"}
        open={!!editor}
        onCancel={() => !action.busy && setEditor(null)}
        onOk={() => form.submit()}
        confirmLoading={action.busy}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void save(values)}
          disabled={action.busy}
        >
          <Form.Item
            name="name"
            label="音色名称"
            rules={[{ required: true, whitespace: true, max: 80 }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="language" label="语言" rules={[{ required: true }]}>
            <Select
              disabled={locked}
              options={[
                { value: "zh-CN", label: "普通话" },
                { value: "en-US", label: "英语" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="speakerId"
            label="百炼公共音色编号"
            rules={[{ required: true }]}
            extra={
              <a
                href="https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list"
                target="_blank"
                rel="noreferrer"
              >
                查看百炼系统音色列表
              </a>
            }
          >
            <Input
              disabled={locked}
              maxLength={150}
              placeholder="例如 longanlingxin_v3.1"
            />
          </Form.Item>
          <Form.Item label="合成模型" htmlFor="public-voice-model">
            <Input id="public-voice-model" value={publicVoiceModel} readOnly />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
