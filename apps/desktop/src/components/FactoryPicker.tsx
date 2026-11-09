import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  factoryRequest,
  templateKey,
  type FactoryProperties,
  type FactoryProperty,
  type FactoryTemplate,
} from "./factoryClient";

const PAGE_SIZE = 20;
const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));

export function FactoryPicker({
  kind,
  value,
  templates,
  onClose,
  onConfirm,
  onProperties,
}: {
  kind: "property" | "template";
  value: string[];
  templates: FactoryTemplate[];
  onClose: () => void;
  onConfirm: (values: string[]) => void;
  onProperties: (rows: Pick<FactoryProperty, "id" | "title">[]) => void;
}) {
  const { message } = App.useApp();
  const [selected, setSelected] = useState(() => new Set(value));
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [district, setDistrict] = useState<string>();
  const [material, setMaterial] = useState<string>();
  const [language, setLanguage] = useState<string>();
  const [mode, setMode] = useState<string>();
  const [ratio, setRatio] = useState<string>();
  const [page, setPage] = useState(1);
  const [selecting, setSelecting] = useState(false);
  const [preview, setPreview] = useState<FactoryTemplate>();
  const property = kind === "property";
  const query = {
    search,
    district,
    material,
    selectedIds: selectedOnly ? [...selected] : undefined,
  };
  const properties = useQuery({
    queryKey: ["factory-properties", query, page],
    queryFn: () =>
      factoryRequest<FactoryProperties>("properties", { ...query, page }),
    enabled: property,
    retry: false,
  });
  const templateRows = property
    ? []
    : templates.filter(
        (t) =>
          (!selectedOnly || selected.has(templateKey(t))) &&
          (t.name + " " + (t.description || "") + " " + t.version)
            .toLowerCase()
            .includes(search.trim().toLowerCase()) &&
          (!language || t.config.language === language) &&
          (!mode || t.config.videoMode === mode) &&
          (!ratio || t.config.aspectRatio === ratio),
      );
  const templatePage = Math.min(
    page,
    Math.max(1, Math.ceil(templateRows.length / PAGE_SIZE)),
  );
  const shownTemplates = templateRows.slice(
    (templatePage - 1) * PAGE_SIZE,
    templatePage * PAGE_SIZE,
  );
  const propertyRows = properties.data?.rows || [];
  const toggle = (ids: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const pageIds = property
    ? propertyRows
        .filter((row) => row.importStatus === "ready")
        .map((row) => row.id)
    : shownTemplates.map(templateKey);
  const paginate = {
    pageSize: PAGE_SIZE,
    showSizeChanger: false,
    onChange: setPage,
  };
  const chooseAll = async () => {
    if (!property) {
      toggle(templateRows.map(templateKey), true);
      return;
    }
    setSelecting(true);
    try {
      const result = await factoryRequest<{
        rows: Pick<FactoryProperty, "id" | "title">[];
      }>("properties", {
        ...query,
        all: true,
      });
      toggle(
        result.rows.map((row) => row.id),
        true,
      );
      onProperties(result.rows);
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "无法选择筛选结果",
      );
    } finally {
      setSelecting(false);
    }
  };
  const check = (id: string, label: string, disabled = false) => (
    <Checkbox
      aria-label={"选择" + label}
      checked={selected.has(id)}
      disabled={disabled && !selected.has(id)}
      onChange={(event) => {
        if (property) onProperties(propertyRows);
        toggle([id], event.target.checked);
      }}
    />
  );
  return (
    <Modal
      title={property ? "选择房源" : "选择视频模板"}
      open
      width={960}
      onCancel={onClose}
      okText={"确认选择（" + selected.size + "）"}
      cancelText="取消"
      onOk={() => {
        if (property) onProperties(propertyRows);
        onConfirm([...selected]);
      }}
      footer={(_, { OkBtn, CancelBtn }) => (
        <div className="factory-picker-footer">
          <span>
            已选 <strong>{selected.size}</strong>{" "}
            {property ? "套房源" : "个模板"}
          </span>
          <Space>
            <Button type="text" onClick={() => setSelected(new Set())}>
              清空选择
            </Button>
            <CancelBtn />
            <OkBtn />
          </Space>
        </div>
      )}
    >
      <Space wrap className="factory-tools">
        <Input
          aria-label={property ? "搜索房源" : "搜索模板"}
          allowClear
          prefix={<Search size={15} />}
          placeholder={property ? "房源号、小区或标题" : "搜索名称、描述或版本"}
          value={search}
          maxLength={120}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {property ? (
          <>
            <Select
              aria-label="区域"
              placeholder="全部区域"
              className="factory-filter"
              allowClear
              showSearch
              options={options(properties.data?.districts || [])}
              value={district}
              onChange={(v) => {
                setDistrict(v);
                setPage(1);
              }}
            />
            <Select
              aria-label="素材状态"
              placeholder="全部素材状态"
              className="factory-filter"
              allowClear
              options={[
                { value: "ready", label: "素材就绪" },
                { value: "incomplete", label: "缺少素材" },
              ]}
              value={material}
              onChange={(v) => {
                setMaterial(v);
                setPage(1);
              }}
            />
          </>
        ) : (
          <>
            <Select
              aria-label="语言"
              placeholder="全部语言"
              className="factory-filter"
              allowClear
              value={language}
              options={[
                { value: "zh-CN", label: "中文" },
                { value: "en-US", label: "英文" },
              ]}
              onChange={(v) => {
                setLanguage(v);
                setPage(1);
              }}
            />
            <Select
              aria-label="视频模式"
              placeholder="全部模式"
              className="factory-filter"
              allowClear
              value={mode}
              options={[
                { value: "voiceover", label: "配音" },
                { value: "avatar", label: "露脸" },
              ]}
              onChange={(v) => {
                setMode(v);
                setPage(1);
              }}
            />
            <Select
              aria-label="视频比例"
              placeholder="全部比例"
              className="factory-filter"
              allowClear
              value={ratio}
              options={options(["9:16", "16:9"])}
              onChange={(v) => {
                setRatio(v);
                setPage(1);
              }}
            />
          </>
        )}
      </Space>
      <Space wrap className="factory-tools">
        <Checkbox
          checked={selectedOnly}
          onChange={(e) => {
            setSelectedOnly(e.target.checked);
            setPage(1);
          }}
        >
          仅看已选
        </Checkbox>
        <Checkbox
          checked={
            pageIds.length > 0 && pageIds.every((id) => selected.has(id))
          }
          indeterminate={
            pageIds.some((id) => selected.has(id)) &&
            !pageIds.every((id) => selected.has(id))
          }
          disabled={!pageIds.length}
          onChange={(e) => {
            if (property) onProperties(propertyRows);
            toggle(pageIds, e.target.checked);
          }}
        >
          全选本页
        </Checkbox>
        <Button
          size="small"
          onClick={() => void chooseAll()}
          loading={selecting}
          disabled={
            selectedOnly || (property ? !properties.data : !templateRows.length)
          }
        >
          全选筛选结果
        </Button>
        <span className="muted">
          符合条件{" "}
          {property ? properties.data?.total || 0 : templateRows.length} 项
        </span>
      </Space>
      {properties.isError && property && (
        <Alert
          showIcon
          type="error"
          title={properties.error.message}
          action={
            <Button onClick={() => void properties.refetch()}>重试</Button>
          }
        />
      )}
      {property ? (
        <Table
          size="small"
          rowKey="id"
          dataSource={propertyRows}
          loading={properties.isFetching}
          pagination={{
            ...paginate,
            current: properties.data?.page || 1,
            total: properties.data?.total || 0,
          }}
          scroll={{ y: 390 }}
          locale={{ emptyText: "没有符合条件的房源" }}
          columns={[
            {
              title: "",
              width: 44,
              render: (_, row) =>
                check(row.id, row.title, row.importStatus !== "ready"),
            },
            {
              title: "房源",
              render: (_, row) => (
                <div className="factory-property-cell">
                  {row.image && (
                    <img
                      loading="lazy"
                      alt=""
                      src={row.image}
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        e.currentTarget.hidden = true;
                      }}
                    />
                  )}
                  <span>
                    <strong>{row.title}</strong>
                    <small>
                      {row.propertyNumber || "无房源号"} · {row.community}
                    </small>
                  </span>
                </div>
              ),
            },
            {
              title: "区域",
              dataIndex: "district",
              width: 120,
              ellipsis: true,
            },
            {
              title: "户型 / 面积",
              width: 150,
              render: (_, row) =>
                [row.layout, row.areaSqm ? row.areaSqm + " ㎡" : ""]
                  .filter(Boolean)
                  .join(" · ") || "—",
            },
            {
              title: "素材状态",
              width: 108,
              render: (_, row) =>
                row.importStatus === "ready" ? (
                  <Tag color="success">
                    {row.sample ? "测试素材" : "素材就绪"}
                  </Tag>
                ) : (
                  <Tag color="warning">缺少素材</Tag>
                ),
            },
          ]}
        />
      ) : (
        <Table
          size="small"
          rowKey={templateKey}
          dataSource={shownTemplates}
          pagination={false}
          scroll={{ y: 360 }}
          locale={{ emptyText: "没有符合条件的模板" }}
          columns={[
            {
              title: "",
              width: 44,
              render: (_, row) =>
                check(templateKey(row), row.name + " · " + row.version),
            },
            {
              title: "模板",
              render: (_, row) => (
                <span className="factory-template-cell">
                  <strong>{row.name}</strong>
                  <small>{row.description}</small>
                </span>
              ),
            },
            { title: "版本", dataIndex: "version", width: 90, ellipsis: true },
            {
              title: "制作规格",
              width: 220,
              render: (_, row) =>
                [
                  row.config.language === "en-US" ? "英文" : "中文",
                  row.config.videoMode === "avatar" ? "露脸" : "配音",
                  row.config.aspectRatio,
                  row.config.resolution,
                ].join(" · "),
            },
            {
              title: "",
              width: 76,
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() => setPreview(row)}
                >
                  详情
                </Button>
              ),
            },
          ]}
        />
      )}
      {!property && templateRows.length > PAGE_SIZE && (
        <div className="factory-template-pager">
          <Button
            disabled={templatePage === 1}
            onClick={() => setPage(templatePage - 1)}
          >
            上一页
          </Button>
          <span>
            {templatePage} / {Math.ceil(templateRows.length / PAGE_SIZE)}
          </span>
          <Button
            disabled={templatePage * PAGE_SIZE >= templateRows.length}
            onClick={() => setPage(templatePage + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      {preview && (
        <Modal
          open
          title={preview.name}
          onCancel={() => setPreview(undefined)}
          footer={
            <Button onClick={() => setPreview(undefined)}>返回选择</Button>
          }
        >
          <p>{preview.description || "按房源图片顺序组织讲解。"}</p>
          <p>
            版本 {preview.version} · {preview.config.aspectRatio} ·{" "}
            {preview.config.resolution}
          </p>
        </Modal>
      )}
    </Modal>
  );
}
