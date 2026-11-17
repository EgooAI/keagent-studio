import { useEffect, useId, useRef, useState } from "react";
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
import type { TableRef } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import {
  factoryRequest,
  templateKey,
  type FactoryProperties,
  type FactoryProperty,
  type FactoryTemplate,
} from "./factoryClient";
import "./factory-picker.css";

const PAGE_SIZE = 20;
const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));

function propertySize(row: FactoryProperty) {
  return [row.layout, row.areaSqm ? row.areaSqm + " ㎡" : ""]
    .filter(Boolean)
    .join(" · ");
}

function MaterialStatus({ row }: { row: FactoryProperty }) {
  if (row.importStatus !== "ready") return <Tag color="warning">缺少素材</Tag>;
  return <Tag color="success">{row.sample ? "测试素材" : "素材就绪"}</Tag>;
}

function templateSpecs(template: FactoryTemplate) {
  return [
    template.config.language === "en-US" ? "英文" : "中文",
    template.opening
      ? "MiniMax H3"
      : template.config.videoMode === "avatar"
        ? "露脸"
        : "配音",
    template.config.aspectRatio,
    template.config.resolution,
  ].join(" · ");
}

function TemplateDetail({
  template,
  onClose,
}: {
  template: FactoryTemplate;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  return (
    <Modal
      open={open}
      centered
      width={520}
      title={template.name}
      className="factory-template-detail"
      classNames={{ mask: "factory-template-detail-mask" }}
      closable={{ "aria-label": "关闭模板详情" }}
      onCancel={close}
      afterClose={onClose}
      footer={
        <Button type="primary" onClick={close}>
          返回选择
        </Button>
      }
    >
      <p className="factory-template-detail-description">
        {template.description || "按房源图片顺序组织讲解。"}
      </p>
      <dl className="factory-template-detail-specs">
        <div>
          <dt>版本</dt>
          <dd>{template.version}</dd>
        </div>
        <div>
          <dt>画面比例</dt>
          <dd>{template.config.aspectRatio}</dd>
        </div>
        <div>
          <dt>分辨率</dt>
          <dd>{template.config.resolution}</dd>
        </div>
      </dl>
    </Modal>
  );
}

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
  const checkboxPrefix = useId();
  const checkboxId = (id: string) =>
    `${checkboxPrefix}-${encodeURIComponent(id)}`;
  const templateTable = useRef<TableRef>(null);
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
  useEffect(() => {
    templateTable.current?.scrollTo({ top: 0 });
  }, [templatePage, search, language, mode, ratio, selectedOnly]);
  const propertyRows = properties.data?.rows || [];
  const matchCount = property ? properties.data?.total : templateRows.length;
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
        .filter((row) => row.importStatus === "ready" || selected.has(row.id))
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
      id={checkboxId(id)}
      aria-label={"选择" + label}
      checked={selected.has(id)}
      disabled={selecting || (disabled && !selected.has(id))}
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
      centered
      className={`factory-picker-modal ${property ? "factory-property-picker-modal" : "factory-template-picker-modal"}`}
      width={960}
      onCancel={onClose}
      okText={"确认选择（" + selected.size + "）"}
      cancelText="取消"
      okButtonProps={{ disabled: selecting }}
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
            <Button
              type="text"
              disabled={selecting}
              onClick={() => setSelected(new Set())}
            >
              清空选择
            </Button>
            <CancelBtn />
            <OkBtn />
          </Space>
        </div>
      )}
    >
      <Space wrap className="factory-tools factory-picker-filters">
        <Input
          aria-label={property ? "搜索房源" : "搜索模板"}
          allowClear
          prefix={<Search size={15} />}
          placeholder={property ? "房源号、小区或标题" : "搜索名称、描述或版本"}
          value={search}
          maxLength={120}
          disabled={selecting}
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
              disabled={selecting}
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
              disabled={selecting}
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
      <Space wrap className="factory-tools factory-picker-selection">
        <Checkbox
          checked={selectedOnly}
          disabled={selecting}
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
          disabled={selecting || !pageIds.length}
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
        <span className="muted factory-picker-match-count" role="status">
          {matchCount !== undefined
            ? `符合条件 ${matchCount} 项`
            : properties.isPending && "正在读取房源…"}
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
          className="factory-picker-table factory-property-table"
          size="small"
          rowKey="id"
          rowClassName={(row) =>
            selected.has(row.id)
              ? "is-selected"
              : row.importStatus !== "ready"
                ? "is-unavailable"
                : ""
          }
          dataSource={propertyRows}
          loading={properties.isFetching}
          pagination={{
            ...paginate,
            current: properties.data?.page || 1,
            total: properties.data?.total || 0,
          }}
          scroll={{ y: "var(--factory-property-list-height, 390px)" }}
          locale={{
            emptyText: properties.isError
              ? "暂时无法显示房源"
              : "没有符合条件的房源",
          }}
          columns={[
            {
              title: "",
              width: 52,
              render: (_, row) =>
                check(row.id, row.title, row.importStatus !== "ready"),
            },
            {
              title: "房源",
              render: (_, row) => (
                <label
                  className="factory-property-cell"
                  htmlFor={checkboxId(row.id)}
                >
                  <span className="factory-property-cover" aria-hidden="true">
                    <Building2 size={22} />
                    {row.image && (
                      <img
                        key={row.image}
                        loading="lazy"
                        alt=""
                        src={row.image}
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          e.currentTarget.hidden = true;
                        }}
                      />
                    )}
                  </span>
                  <span className="factory-property-name">
                    <strong>{row.title}</strong>
                    <small>
                      {[row.propertyNumber || "无房源号", row.community]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    <span className="factory-property-compact">
                      <span>
                        {[row.district, propertySize(row)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <MaterialStatus row={row} />
                    </span>
                  </span>
                </label>
              ),
            },
            {
              title: "区域",
              dataIndex: "district",
              responsive: ["md"],
              width: 120,
              ellipsis: true,
            },
            {
              title: "户型 / 面积",
              width: 168,
              responsive: ["md"],
              render: (_, row) => propertySize(row) || "—",
            },
            {
              title: "素材状态",
              width: 124,
              responsive: ["md"],
              render: (_, row) => <MaterialStatus row={row} />,
            },
          ]}
        />
      ) : (
        <Table
          ref={templateTable}
          className="factory-picker-table factory-template-table"
          size="small"
          rowKey={templateKey}
          rowClassName={(row) =>
            selected.has(templateKey(row)) ? "is-selected" : ""
          }
          dataSource={shownTemplates}
          pagination={false}
          scroll={{ y: "var(--factory-template-list-height, 400px)" }}
          locale={{ emptyText: "没有符合条件的模板" }}
          columns={[
            {
              title: "",
              width: 52,
              render: (_, row) =>
                check(templateKey(row), row.name + " · " + row.version),
            },
            {
              title: "模板",
              render: (_, row) => (
                <label
                  className="factory-template-cell"
                  htmlFor={checkboxId(templateKey(row))}
                >
                  <strong>{row.name}</strong>
                  {row.description && (
                    <small className="factory-template-description">
                      {row.description}
                    </small>
                  )}
                  <span className="factory-template-compact">
                    版本 {row.version} · {templateSpecs(row)}
                  </span>
                </label>
              ),
            },
            {
              title: "版本",
              dataIndex: "version",
              width: 104,
              ellipsis: true,
              responsive: ["md"],
            },
            {
              title: "制作规格",
              width: 246,
              responsive: ["md"],
              render: (_, row) => templateSpecs(row),
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
        <TemplateDetail
          template={preview}
          onClose={() => setPreview(undefined)}
        />
      )}
    </Modal>
  );
}
