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
import { serviceRequest } from "@keagent/api-client";
import type { AdminPublicVoice } from "@keagent/shared-types";
import { useAdminAction } from "./admin-api";

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
        resourceId: "seed-tts-2.0",
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
        }),
      "公共音色已保存",
    );
    if (saved) setEditor(null);
  }
  const locked = !!editor && editor !== "new" && editor.publishedOnce;
  return (
    <>
      <Alert
        type="info"
        showIcon
        title="用户只能选择已上架的公共音色或本人音色"
        description="在这里配置名称、语言、火山公共音色编号和合成资源。上架过的编号、模型及语言不能覆盖修改；更换音色时请新建，以保持历史制作记录一致。"
      />
      <div className="admin-toolbar admin-block">
        <Button onClick={() => void query.refetch()}>刷新列表</Button>
        <Button type="primary" onClick={() => edit()}>
          新增公共音色
        </Button>
      </div>
      {query.isError && (
        <Alert
          type="error"
          title="无法读取公共音色"
          description={query.error.message}
        />
      )}
      <section className="admin-panel" aria-label="公共音色目录">
        <Table<AdminPublicVoice>
          rowKey="id"
          loading={query.isPending}
          dataSource={query.data || []}
          columns={[
            { title: "名称", dataIndex: "name" },
            {
              title: "语言",
              dataIndex: "language",
              render: (value) => (value === "zh-CN" ? "普通话" : "英语"),
            },
            { title: "火山音色编号", dataIndex: "speakerId" },
            { title: "合成资源", dataIndex: "resourceId" },
            {
              title: "状态",
              render: (_, voice) => (
                <Tag color={voice.enabled ? "green" : "default"}>
                  {voice.enabled ? "已上架" : "未上架"}
                </Tag>
              ),
            },
            {
              title: "操作",
              render: (_, voice) => (
                <Space>
                  <Button size="small" onClick={() => edit(voice)}>
                    编辑
                  </Button>
                  <Button
                    size="small"
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
          pagination={{ pageSize: 20 }}
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
            label="火山公共音色编号"
            rules={[{ required: true }]}
          >
            <Input
              disabled={locked}
              maxLength={150}
              placeholder="从火山语音控制台的公共音色库获取"
            />
          </Form.Item>
          <Form.Item
            name="resourceId"
            label="语音合成资源"
            rules={[{ required: true }]}
          >
            <Input
              disabled={locked}
              maxLength={150}
              placeholder="例如 seed-tts-2.0"
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
