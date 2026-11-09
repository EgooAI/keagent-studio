import { Alert, App, Button, Form, Input, Skeleton, Tabs } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import { ThemeSettings } from "@keagent/theme";
import { useAdminParams } from "./admin-api";

type MailSettings = {
  operationsEmail: string;
  smtpConfigured: boolean;
};

const mailPath = "/v1/admin/douyin/settings";
const mailKey = ["admin", "douyin", "settings"];

export default function AdminSettings() {
  const { params, setParams } = useAdminParams();

  return (
    <Tabs
      activeKey={params.get("tab") === "appearance" ? "appearance" : "mail"}
      onChange={(tab) => setParams({ tab }, false)}
      destroyOnHidden
      items={[
        { key: "mail", label: "邮件通知", children: <MailNotifications /> },
        {
          key: "appearance",
          label: "外观",
          children: (
            <section className="admin-panel admin-settings-panel">
              <ThemeSettings />
              <p className="admin-secondary">
                配色仅应用于当前浏览器的管理后台。
              </p>
            </section>
          ),
        },
      ]}
    />
  );
}

function MailNotifications() {
  const { message } = App.useApp();
  const client = useQueryClient();
  const [form] = Form.useForm<Pick<MailSettings, "operationsEmail">>();
  const query = useQuery({
    queryKey: mailKey,
    queryFn: () => serviceRequest<MailSettings>(mailPath),
  });
  const save = useMutation({
    mutationFn: ({ operationsEmail }: Pick<MailSettings, "operationsEmail">) =>
      serviceRequest<MailSettings>(mailPath, {
        operationsEmail: (operationsEmail || "").trim(),
      }),
    onSuccess: () => {
      message.success("运维邮箱已保存");
      return client.invalidateQueries({ queryKey: mailKey });
    },
  });

  return (
    <section
      className="admin-panel admin-settings-panel"
      aria-labelledby="admin-mail-title"
    >
      <div className="admin-section-heading">
        <div>
          <h2 id="admin-mail-title">抖音发布告警</h2>
          <p className="admin-secondary">接收发布流程异常和恢复通知。</p>
        </div>
      </div>
      {query.isPending ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : !query.data ? (
        <Alert
          type="error"
          showIcon
          title="邮件设置读取失败"
          description={query.error?.message}
          action={
            <Button
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              重试读取
            </Button>
          }
        />
      ) : (
        <>
          <Alert
            type={query.data.smtpConfigured ? "success" : "warning"}
            showIcon
            title={
              query.data.smtpConfigured ? "SMTP 已配置" : "SMTP 尚未完整配置"
            }
            description={
              query.data.smtpConfigured
                ? "实际投递结果以抖音发布页的邮件队列为准。"
                : "可先保存收件邮箱，启用投递还需在服务端补齐 SMTP 配置。"
            }
          />
          <Form
            form={form}
            layout="vertical"
            className="admin-mail-form"
            initialValues={{ operationsEmail: query.data.operationsEmail }}
            onFinish={(values) =>
              save.mutate(values, {
                onSuccess: (data) =>
                  form.setFieldValue("operationsEmail", data.operationsEmail),
              })
            }
          >
            <Form.Item
              name="operationsEmail"
              label="运维邮箱"
              extra="留空并保存即可关闭邮件通知。"
              rules={[
                {
                  type: "email",
                  transform: (value: string | undefined) => value?.trim(),
                  message: "请输入有效邮箱",
                },
              ]}
            >
              <Input
                autoComplete="email"
                maxLength={254}
                disabled={save.isPending}
              />
            </Form.Item>
            {save.error && (
              <Alert
                className="admin-notice"
                type="error"
                showIcon
                title="保存邮箱失败"
                description={save.error.message}
              />
            )}
            <Button
              type="primary"
              htmlType="submit"
              aria-label="保存邮箱"
              loading={save.isPending}
              disabled={save.isPending}
            >
              保存邮箱
            </Button>
          </Form>
        </>
      )}
    </section>
  );
}
