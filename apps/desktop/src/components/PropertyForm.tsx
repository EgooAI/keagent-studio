import { useState } from "react";
import { Alert, App, Form, Input, InputNumber, Modal, Select } from "antd";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { demoApi } from "@keagent/api-client";
import type { Property } from "@keagent/shared-types";
import { request as productionRequest } from "./panoramaClient";
import "./property-form.css";

type PropertyInput = Pick<
  Property,
  | "title"
  | "propertyNumber"
  | "community"
  | "city"
  | "district"
  | "layout"
  | "areaSqm"
  | "priceCents"
  | "description"
  | "sellingPoints"
  | "details"
>;

type PropertyFormValues = Omit<
  PropertyInput,
  "priceCents" | "sellingPoints"
> & {
  price: number;
  sellingPoints?: string;
};

const requiredText = [{ required: true, whitespace: true }];

async function importPropertyVr(propertyId: string, queryClient: QueryClient) {
  const { count } = await productionRequest<{ count: number }>(
    "property-vr-import",
    { propertyId },
  );
  await queryClient.invalidateQueries({
    queryKey: ["property-production-material", propertyId],
  });
  return count;
}

async function validateLink(_: unknown, value?: string) {
  if (!value?.trim()) return;
  try {
    const url = new URL(value.trim());
    if (
      /^https:\/\//i.test(value.trim()) &&
      url.hostname &&
      !url.username &&
      !url.password
    )
      return;
  } catch {
    // Invalid links receive the same field error.
  }
  throw new Error("请输入完整的 HTTPS 链接");
}

export function PropertyForm({
  property,
  onClose,
  onSaved,
}: {
  property?: Property;
  onClose: () => void;
  onSaved?: (property: Property) => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PropertyFormValues>();
  const [phase, setPhase] = useState<"idle" | "saving" | "importing">("idle");
  const busy = phase !== "idle";
  const minimumPrice = property ? 0 : 1;

  async function save(values: PropertyFormValues) {
    if (busy) return;
    setPhase("saving");
    try {
      const { price, sellingPoints, details, ...facts } = values;
      const input: PropertyInput = {
        title: facts.title.trim(),
        propertyNumber: facts.propertyNumber.trim(),
        community: facts.community.trim(),
        city: facts.city?.trim() ?? "",
        district: facts.district?.trim() ?? "",
        layout: facts.layout?.trim() ?? "",
        areaSqm: facts.areaSqm,
        description: facts.description?.trim() ?? "",
        priceCents: Math.round(price * 1000000),
        sellingPoints: (sellingPoints ?? "")
          .split(/\r?\n/)
          .map((point) => point.trim())
          .filter(Boolean),
        details: Object.fromEntries(
          Object.entries(details ?? {})
            .map(([key, value]) => [key, value?.trim() ?? ""])
            .filter(([, value]) => value !== ""),
        ),
      };
      const previousLink = property?.details?.vrUrl;
      const saved = property
        ? await demoApi.updateProperty(property.id, input)
        : await demoApi.createProperty({ ...input, image: "", images: [] });
      const link = saved.details?.vrUrl;
      if (window.desktop && link && link !== previousLink) {
        setPhase("importing");
        try {
          const count = await importPropertyVr(saved.id, queryClient);
          message.success(
            `已为「${saved.community}」导入 ${count} 张 VR 全景图`,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : "请稍后重试";
          message.warning(`房源已保存，全景图导入失败（${reason}）。`, 8);
        }
      } else {
        message.success(
          property ? "房源资料已更新" : "房源已保存，可继续添加素材",
        );
      }
      await queryClient.invalidateQueries(
        { queryKey: ["workspace"] },
        { cancelRefetch: false },
      );
      onClose();
      onSaved?.(saved);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "房源保存失败");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <Modal
      title={property ? "编辑房源资料" : "手动添加房源"}
      open
      width={700}
      centered
      className={
        property
          ? "property-form-modal property-edit-modal"
          : "property-form-modal"
      }
      onCancel={() => {
        if (!busy) onClose();
      }}
      closable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onOk={() => form.submit()}
      confirmLoading={busy}
      okText={
        phase === "importing"
          ? "正在导入全景图…"
          : property
            ? "保存修改"
            : "保存房源"
      }
    >
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        scrollToFirstError={{ block: "nearest", focus: true }}
        onFinish={save}
        initialValues={
          property && {
            ...property,
            price: property.priceCents / 1000000,
            sellingPoints: property.sellingPoints.join("\n"),
          }
        }
      >
        <Form.Item name="title" label="房源标题" rules={requiredText}>
          <Input />
        </Form.Item>
        <div className="property-form-grid">
          <Form.Item name="propertyNumber" label="房源号" rules={requiredText}>
            <Input />
          </Form.Item>
          <Form.Item name="community" label="小区名称" rules={requiredText}>
            <Input />
          </Form.Item>
          <Form.Item name="city" label="城市">
            <Input />
          </Form.Item>
          <Form.Item name="district" label="区县／商圈">
            <Input />
          </Form.Item>
          <Form.Item
            name="price"
            label="总价（万元）"
            rules={[{ required: true, type: "number", min: minimumPrice }]}
          >
            <InputNumber min={minimumPrice} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="areaSqm"
            label="建筑面积（平方米）"
            rules={[{ required: true, type: "number", min: 0.01 }]}
          >
            <InputNumber min={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="layout" label="户型">
            <Input placeholder="例如 2 室 1 厅 1 卫" />
          </Form.Item>
          <Form.Item name={["details", "listingStatus"]} label="挂牌状态">
            <Select
              allowClear
              placeholder="请选择"
              options={["在售", "已成交", "已下架"].map((value) => ({ value }))}
            />
          </Form.Item>
          <Form.Item name={["details", "floor"]} label="楼层">
            <Input maxLength={160} placeholder="例如 中层／共 18 层" />
          </Form.Item>
          <Form.Item name={["details", "orientation"]} label="朝向">
            <Input maxLength={160} />
          </Form.Item>
          <Form.Item name={["details", "elevator"]} label="电梯">
            <Select
              allowClear
              options={[
                { label: "有电梯", value: "有" },
                { label: "无电梯", value: "无" },
              ]}
            />
          </Form.Item>
          <Form.Item name={["details", "buildingAge"]} label="建成年份／楼龄">
            <Input maxLength={160} placeholder="例如 2012 年建成" />
          </Form.Item>
        </div>
        <Form.Item name={["details", "transactionAttributes"]} label="交易属性">
          <Input.TextArea
            rows={2}
            maxLength={800}
            placeholder="例如 普通住宅、商品房、满五唯一"
          />
        </Form.Item>
        <Form.Item name="description" label="房源说明">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item name="sellingPoints" label="房源卖点">
          <Input.TextArea rows={2} placeholder="每行填写一个卖点" />
        </Form.Item>
        <div className="property-form-grid">
          <Form.Item
            name={["details", "listingUrl"]}
            label="房源详情链接"
            rules={[{ validator: validateLink }]}
          >
            <Input maxLength={2048} placeholder="https://…" />
          </Form.Item>
          <Form.Item
            name={["details", "vrUrl"]}
            label="VR 看房链接"
            extra={
              window.desktop &&
              "保存新的如视看房链接后，自动导入全部点位并替换当前房源的全景图。"
            }
            rules={[{ validator: validateLink }]}
          >
            <Input maxLength={2048} placeholder="https://…" />
          </Form.Item>
        </div>
        {!property && (
          <p className="muted">
            保存后可在详情页添加室内照片、全景原图和户型图。
          </p>
        )}
      </Form>
    </Modal>
  );
}

export function PropertyVrLinkForm({
  property,
  onClose,
}: {
  property: Property;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ vrUrl: string }>();
  const [phase, setPhase] = useState<"idle" | "saving" | "importing">("idle");
  const [failure, setFailure] = useState<string>();
  const busy = phase !== "idle";

  async function save({ vrUrl }: { vrUrl: string }) {
    if (busy) return;
    const link = vrUrl.trim();
    setPhase("saving");
    setFailure(undefined);
    let linkSaved = false;
    try {
      if (link !== property.details?.vrUrl) {
        await demoApi.updateProperty(property.id, {
          details: { ...property.details, vrUrl: link },
        });
        await queryClient.invalidateQueries(
          { queryKey: ["workspace"] },
          { cancelRefetch: false },
        );
      }
      linkSaved = true;
      setPhase("importing");
      const count = await importPropertyVr(property.id, queryClient);
      message.success(`已导入 ${count} 张 VR 全景图`);
      onClose();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "请稍后重试";
      setFailure(
        linkSaved
          ? `链接已保存，全景图导入失败（${reason}）。`
          : `链接保存失败（${reason}）。`,
      );
    } finally {
      setPhase("idle");
    }
  }

  return (
    <Modal
      title="添加房源 VR 链接"
      open
      centered
      className="property-form-modal"
      onCancel={() => {
        if (!busy) onClose();
      }}
      closable={!busy}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onOk={() => form.submit()}
      okText={phase === "importing" ? "正在导入全景图…" : "保存并导入"}
    >
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        initialValues={{ vrUrl: property.details?.vrUrl ?? "" }}
        onFinish={save}
      >
        <Form.Item
          name="vrUrl"
          label="VR 看房链接"
          extra="粘贴公开的如视 VR 看房链接，保存后自动导入全景图。"
          rules={[
            { required: true, whitespace: true, message: "请输入 VR 看房链接" },
            { validator: validateLink },
          ]}
        >
          <Input placeholder="https://…" maxLength={2048} />
        </Form.Item>
        {failure && <Alert type="error" showIcon title={failure} />}
      </Form>
    </Modal>
  );
}
