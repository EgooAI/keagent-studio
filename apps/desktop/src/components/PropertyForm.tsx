import { useState } from "react";
import { App, Form, Input, InputNumber, Modal, Select } from "antd";
import type { Property } from "@keagent/shared-types";

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
  onSave,
}: {
  property?: Property;
  onClose: () => void;
  onSave: (input: PropertyInput) => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PropertyFormValues>();
  const [saving, setSaving] = useState(false);
  const minimumPrice = property ? 0 : 1;

  async function save(values: PropertyFormValues) {
    setSaving(true);
    try {
      const { price, sellingPoints, details, ...facts } = values;
      await onSave({
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
      });
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "房源保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={property ? "编辑房源资料" : "手动添加房源"}
      open
      width={700}
      styles={{ body: { maxHeight: "66vh", overflowY: "auto" } }}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={saving}
      okText={property ? "保存修改" : "保存房源"}
    >
      <Form
        form={form}
        layout="vertical"
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
        <div className="form-two">
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
        <div className="form-two">
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
