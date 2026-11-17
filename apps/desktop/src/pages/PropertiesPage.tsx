import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  App,
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  FileUp,
  LayoutGrid,
  List,
  MapPin,
  Play,
  Plus,
  Search,
  Upload as UploadIcon,
} from "lucide-react";
import {
  demoApi,
  isLive,
  searchBeikeHouses,
  serviceRequest,
} from "@keagent/api-client";
import type {
  BeikeHouse,
  BeikeSearchResult,
  ImportResult,
  Property,
} from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { beikeHouseToPropertyInput } from "../lib/beike";
import {
  PageHeader,
  PropertyPhoto,
  StatusTag,
  formatDate,
  formatPrice,
} from "../components/common";
import { parseCsv, propertyNumbersFromRows } from "../lib/importFile";
import { request as productionRequest } from "../components/panoramaClient";
import { PropertyForm } from "../components/PropertyForm";
import { DeletePropertyButton } from "../components/DeletePropertyButton";
import type { PanoramaScene } from "@keagent/shared-types";

export default function PropertiesPage() {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("grid");
  const [searchParams] = useSearchParams();
  const [importOpen, setImportOpen] = useState(
    searchParams.get("import") === "1",
  );
  const [manualOpen, setManualOpen] = useState(false);
  if (!data) return null;
  const publishedIds = new Set(
    data.publishTasks
      .filter((p) => p.status === "published")
      .map(
        (p) => data.tasks.find((t) => t.id === p.productionTaskId)?.propertyId,
      )
      .filter((id) => data.properties.some((property) => property.id === id)),
  );
  const filtered = data.properties.filter(
    (p) =>
      `${p.title} ${p.community} ${p.propertyNumber} ${p.city} ${p.district}`.includes(
        search,
      ) &&
      (filter === "all" ||
        (filter === "published"
          ? publishedIds.has(p.id)
          : !publishedIds.has(p.id))),
  );
  return (
    <>
      <PageHeader
        title="房源中心"
        description="查找房源、补充素材，再选择房源制作视频。"
        actions={
          <>
            <Button
              icon={<Plus size={16} />}
              onClick={() => setManualOpen(true)}
            >
              手动添加
            </Button>
            <Button
              type="primary"
              icon={<UploadIcon size={16} />}
              onClick={() => setImportOpen(true)}
            >
              导入房源
            </Button>
          </>
        }
      />
      <div className="property-toolbar">
        <div className="filter-pills" role="group" aria-label="房源发布分类">
          {[
            ["all", "全部房源"],
            ["unpublished", "未发布过"],
            ["published", "已发布过"],
          ].map(([key, label]) => (
            <button
              className={filter === key ? "active" : ""}
              aria-pressed={filter === key}
              key={key}
              onClick={() => setFilter(key)}
            >
              {label}
              <span>
                {key === "all"
                  ? data.properties.length
                  : key === "published"
                    ? publishedIds.size
                    : data.properties.length - publishedIds.size}
              </span>
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <Input
            aria-label="搜索房源"
            placeholder="搜索房源号、小区、城市或区域"
            prefix={<Search size={16} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
          <Segmented
            value={view}
            onChange={(v) => setView(String(v))}
            options={[
              {
                value: "grid",
                icon: <LayoutGrid size={16} />,
                label: <span className="sr-only">卡片视图</span>,
              },
              {
                value: "table",
                icon: <List size={16} />,
                label: <span className="sr-only">表格视图</span>,
              },
            ]}
          />
        </div>
      </div>
      <div className="list-caption">
        <span>共 {filtered.length} 套房源</span>
        {!isLive && <span>房源资料为演示内容，不构成真实交易信息</span>}
      </div>
      {!filtered.length ? (
        <div className="panel empty-panel">
          <Empty description="没有匹配的房源">
            <Button
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              清除筛选
            </Button>
          </Empty>
        </div>
      ) : view === "grid" ? (
        <div className="property-grid">
          {filtered.map((property) => (
            <article className="property-card" key={property.id}>
              <Link
                to={`/properties/${property.id}`}
                className="property-image-link"
              >
                <PropertyPhoto property={property} />
                <span
                  className={`photo-state ${publishedIds.has(property.id) ? "published" : ""}`}
                >
                  {property.sample
                    ? "测试素材"
                    : publishedIds.has(property.id)
                      ? "已发布过"
                      : "未发布过"}
                </span>
                <span className="media-count">
                  <Play size={11} fill="currentColor" /> {property.videoCount}{" "}
                  段视频
                </span>
              </Link>
              <div className="property-card-body">
                <div className="property-title">
                  <Link to={`/properties/${property.id}`}>
                    {property.community}
                  </Link>
                  <strong>
                    {property.sample
                      ? "测试样例"
                      : formatPrice(property.priceCents)}
                  </strong>
                </div>
                <p className="property-summary">
                  {property.layout}
                  <span />
                  {property.sample ? "两张原全景图" : `${property.areaSqm} m²`}
                  <span />
                  {property.district}
                </p>
                <p className="property-description">{property.title}</p>
                <p className="muted property-number">
                  房源号 {property.propertyNumber}
                </p>
                <div className="property-tags">
                  {property.sellingPoints.slice(0, 3).map((point) => (
                    <span key={point}>{point}</span>
                  ))}
                </div>
                <div className="property-card-footer">
                  <span>
                    {property.importStatus === "ready"
                      ? "素材已就绪"
                      : "待补充素材"}
                  </span>
                  <DeletePropertyButton property={property} compact />
                  <Link
                    to={`/studio/create?propertyId=${property.id}`}
                    className="text-link"
                  >
                    创建视频 <ArrowUpRight size={14} />
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Table
            rowKey="id"
            dataSource={filtered}
            pagination={{ pageSize: 8 }}
            columns={[
              {
                title: "房源",
                render: (_, p: Property) => (
                  <Link to={`/properties/${p.id}`} className="table-property">
                    <PropertyPhoto property={p} />
                    <span>
                      {p.community}
                      <small>{p.propertyNumber}</small>
                    </span>
                  </Link>
                ),
              },
              { title: "户型", dataIndex: "layout" },
              {
                title: "面积",
                render: (_, p: Property) =>
                  p.sample ? "未提供" : `${p.areaSqm} m²`,
              },
              {
                title: "总价",
                render: (_, p: Property) =>
                  p.sample ? "测试样例" : formatPrice(p.priceCents),
              },
              {
                title: "发布",
                render: (_, p: Property) => (
                  <Tag>{publishedIds.has(p.id) ? "已发布过" : "未发布过"}</Tag>
                ),
              },
              {
                title: "操作",
                render: (_, p: Property) => (
                  <>
                    <Link to={`/studio/create?propertyId=${p.id}`}>
                      创建视频
                    </Link>
                    <DeletePropertyButton property={p} compact />
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
      {isLive ? (
        <LiveImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onManual={() => {
            setImportOpen(false);
            setManualOpen(true);
          }}
        />
      ) : (
        <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      )}
      {manualOpen && (
        <PropertyForm
          onClose={() => setManualOpen(false)}
          onSaved={(property) => navigate(`/properties/${property.id}`)}
        />
      )}
    </>
  );
}

type BeikeCliStatus = {
  available: boolean;
  configured: boolean;
  reason: "not_configured" | "ready";
};

function LiveImportModal({
  open,
  onClose,
  onManual,
}: {
  open: boolean;
  onClose: () => void;
  onManual: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [city, setCity] = useState("北京");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BeikeSearchResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const status = useQuery({
    queryKey: ["beike-cli-status"],
    enabled: open,
    retry: false,
    queryFn: async () =>
      window.desktop
        ? ((await window.desktop.request("beikeCli.status")) as BeikeCliStatus)
        : serviceRequest<BeikeCliStatus>("/v1/beike-cli/status", {}),
  });
  const configured = status.data?.reason === "ready";

  async function runSearch() {
    if (!query.trim()) {
      message.warning("请输入搜索条件");
      return;
    }
    setSearching(true);
    try {
      const next = await searchBeikeHouses(city.trim(), query.trim());
      setResult(next);
      setSelected([]);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function importSelected() {
    const chosen = [
      ...(result?.houses ?? []),
      ...(result?.overBudget ?? []),
    ].filter((house) => selected.includes(house.id));
    if (!chosen.length) return;
    setImporting(true);
    let imported = 0;
    let failed = 0;
    try {
      for (const house of chosen) {
        try {
          await demoApi.createProperty(
            beikeHouseToPropertyInput(house, city.trim()),
          );
          imported += 1;
        } catch {
          failed += 1;
        }
      }
      await queryClient.invalidateQueries(
        { queryKey: ["workspace"] },
        { cancelRefetch: false },
      );
      if (imported) message.success(`已导入 ${imported} 套贝壳房源`);
      if (failed) message.warning(`${failed} 套未导入（可能已存在）`);
      if (imported) {
        setResult(undefined);
        setSelected([]);
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  if (!configured) {
    return (
      <Modal
        title="从贝壳找房"
        open={open}
        onCancel={onClose}
        onOk={onManual}
        cancelText="关闭"
        okText="手动添加房源"
      >
        <p role="status">
          {status.isFetching
            ? "正在检查贝壳 CLI 状态…"
            : "云端尚未配置贝壳 CLI，暂不能自动找房。"}
        </p>
      </Modal>
    );
  }

  const houses = result?.houses ?? [];
  const overBudget = result?.overBudget ?? [];

  return (
    <Modal
      title="从贝壳找房"
      open={open}
      onCancel={onClose}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            loading={importing}
            disabled={!selected.length}
            onClick={importSelected}
          >
            导入选中（{selected.length}）
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Input
          aria-label="城市"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          style={{ width: 110 }}
        />
        <Input
          aria-label="搜索条件"
          placeholder="例如：望京 两居 500万以内"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={runSearch}
          style={{ flex: 1 }}
        />
        <Button type="primary" loading={searching} onClick={runSearch}>
          搜索
        </Button>
      </div>
      {result && (
        <p className="muted" role="status">
          召回 {result.totalRecalled} 套，展示 {result.returned} 套
          {result.strictBudgetWan != null
            ? `（已按 ${result.strictBudgetWan} 万严格过滤）`
            : ""}
        </p>
      )}
      {houses.length > 0 && (
        <Checkbox.Group
          style={{ display: "block", maxHeight: 320, overflow: "auto" }}
          value={selected}
          onChange={(values) => setSelected(values as string[])}
        >
          {houses.map((house) => (
            <HouseRow key={house.id} house={house} />
          ))}
        </Checkbox.Group>
      )}
      {overBudget.length > 0 && (
        <>
          <Alert
            style={{ marginTop: 8 }}
            type="warning"
            showIcon
            message={`${overBudget.length} 套超过预算，已单独列出`}
          />
          <Checkbox.Group
            style={{ display: "block", maxHeight: 200, overflow: "auto" }}
            value={selected}
            onChange={(values) => setSelected(values as string[])}
          >
            {overBudget.map((house) => (
              <HouseRow key={house.id} house={house} overBudget />
            ))}
          </Checkbox.Group>
        </>
      )}
      {result && !houses.length && !overBudget.length && (
        <p className="muted">没有符合条件的结果，请调整搜索条件。</p>
      )}
    </Modal>
  );
}

function HouseRow({
  house,
  overBudget,
}: {
  house: BeikeHouse;
  overBudget?: boolean;
}) {
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
      <Checkbox value={house.id}>
        <strong>{house.community}</strong>
        <span className="muted">
          {" "}
          {house.layout} · {house.areaSqm}㎡ · 总价 {house.totalPriceWan}万
        </span>
        {overBudget && <Tag color="orange">超预算</Tag>}
        <div className="muted" style={{ fontSize: 12 }}>
          {house.title}
        </div>
      </Checkbox>
    </div>
  );
}

function ImportModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  async function submit(numbers = input.split(/[\s,，;；]+/).filter(Boolean)) {
    if (!numbers.length) {
      message.warning("请输入至少一个房源号");
      return;
    }
    setBusy(true);
    try {
      const next = await demoApi.importProperties(numbers);
      setResult(next);
      if (next.imported) message.success(`已导入 ${next.imported} 套演示房源`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function readFile(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("文件不能超过 5 MB");
      let rows: unknown[][];
      if (file.name.toLowerCase().endsWith(".xlsx")) {
        const { default: readXlsxFile } =
          await import("read-excel-file/browser");
        const sheets = await readXlsxFile(file);
        rows = sheets[0]?.data ?? [];
      } else if (file.name.toLowerCase().endsWith(".csv")) {
        rows = parseCsv(await file.text());
      } else {
        throw new Error("请选择 .csv 或 .xlsx 文件");
      }
      setInput(propertyNumbersFromRows(rows).join("\n"));
      setResult(undefined);
      message.success("文件已读取，请检查房源号后开始导入");
    } catch (error) {
      message.error((error as Error).message);
    }
    return false;
  }
  return (
    <Modal
      title="导入房源"
      open={open}
      onCancel={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" loading={busy} onClick={() => submit()}>
            开始模拟导入
          </Button>
        </>
      }
    >
      <p className="muted">
        暂未连接贝壳接口。输入房源号可体验模拟查询，也可上传 CSV / Excel 文件。
      </p>
      <Form layout="vertical">
        <Form.Item label="房源号（每行一个，自动去除空行与重复）">
          <Input.TextArea
            aria-label="房源号列表"
            rows={7}
            placeholder={"例如：\nSH10990312\nSH10990313\nSH10990314"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setResult(undefined);
            }}
          />
        </Form.Item>
      </Form>
      <Upload
        beforeUpload={readFile}
        accept=".csv,.xlsx"
        showUploadList={false}
      >
        <Button icon={<FileUp size={16} />}>从 CSV / Excel 读取</Button>
      </Upload>
      <span className="muted inline-note">支持首列或“房源号”列，最大 5 MB</span>
      {busy && <p role="status">正在校验并获取模拟房源资料…</p>}
      {result && (
        <div className="import-result" role="status">
          <strong>本次导入完成</strong>
          <p>
            成功 {result.imported} 套 · 重复 {result.duplicates} 套 · 失败{" "}
            {result.failed.length} 套
          </p>
          {result.failed.length > 0 && (
            <>
              <p>失败项：{result.failed.join("、")}</p>
              <Button size="small" onClick={() => submit(result.failed)}>
                重试失败项
              </Button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

export function PropertyDetailPage() {
  const { propertyId } = useParams();
  const { data } = useWorkspace();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const material = useQuery({
    queryKey: ["property-production-material", propertyId],
    enabled: !!window.desktop && !!propertyId,
    retry: false,
    queryFn: () =>
      productionRequest<{
        scenes: PanoramaScene[];
        references?: Pick<PanoramaScene, "id" | "url" | "room">[];
      }>("source-restore", {
        propertyId,
      }),
  });
  const property = data?.properties.find((p) => p.id === propertyId);
  const addMaterial = async (kind: "panorama" | "reference" | "spatial") => {
    setImporting(true);
    try {
      const value = await productionRequest<{ count: number }>(
        kind === "spatial" ? "property-vr-import" : "property-import",
        kind === "spatial" ? { propertyId } : { propertyId, kind },
      );
      await Promise.all([
        material.refetch(),
        queryClient.invalidateQueries({ queryKey: ["workspace"] }),
      ]);
      if (value.count) void message.success(`已保存${value.count}张房源图片`);
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "导入素材失败",
      );
    } finally {
      setImporting(false);
    }
  };
  if (!data) return null;
  if (!property)
    return (
      <Empty description="房源不存在">
        <Button onClick={() => navigate("/properties")}>返回房源中心</Button>
      </Empty>
    );
  const tasks = data.tasks.filter((t) => t.propertyId === property.id);
  const details = property.details;
  const extraFacts = [
    ["挂牌状态", details?.listingStatus],
    ["楼层", details?.floor],
    ["朝向", details?.orientation],
    ["电梯", details?.elevator],
    ["建成年份／楼龄", details?.buildingAge],
    ["交易属性", details?.transactionAttributes],
  ].filter(([, value]) => value);
  return (
    <>
      <Link className="back-link" to="/properties">
        <ArrowLeft size={16} /> 房源中心
      </Link>
      <PageHeader
        title={property.community}
        description={`${property.city} · ${property.district} · 房源号 ${property.propertyNumber}`}
        actions={
          <>
            <DeletePropertyButton
              property={property}
              onDeleted={() => navigate("/properties", { replace: true })}
            />
            <Button
              disabled={property.sample || importing}
              onClick={() => setEditing(true)}
            >
              {property.sample ? "内置测试资料" : "编辑房源"}
            </Button>
            <Button
              type="primary"
              onClick={() =>
                navigate(`/studio/create?propertyId=${property.id}`)
              }
            >
              创建视频任务 <ArrowUpRight size={16} />
            </Button>
          </>
        }
      />
      {property.sample && (
        <Alert
          style={{ marginBottom: 20 }}
          type="info"
          showIcon
          title="内置测试房源，非真实在售房源"
          description="已附带两张原全景素材，使用模板文案和本机配音，无需贝壳接口或云端配音即可测试视频。两个场景来自不同地点；成片可预览、下载，不能作为正式房源视频发布。"
        />
      )}
      <Tabs
        className="property-detail-tabs"
        items={[
          {
            key: "info",
            label: "房源资料",
            children: (
              <div className="property-overview">
                {" "}
                <div className="property-hero">
                  <PropertyPhoto property={property} />
                </div>
                <div className="panel detail-info">
                  <h2>{property.title}</h2>
                  <div className="property-facts">
                    <div>
                      <strong>
                        {property.sample
                          ? "未提供"
                          : formatPrice(property.priceCents)}
                      </strong>
                      <span>总价</span>
                    </div>
                    <div>
                      <strong>{property.layout || "未提供"}</strong>
                      <span>户型</span>
                    </div>
                    <div>
                      <strong>
                        {property.sample ? "未提供" : `${property.areaSqm} m²`}
                      </strong>
                      <span>建筑面积</span>
                    </div>
                  </div>
                  {property.priceCents > 0 && property.areaSqm > 0 && (
                    <p className="muted">
                      单价约{" "}
                      {Math.round(
                        property.priceCents / 100 / property.areaSqm,
                      ).toLocaleString("zh-CN")}{" "}
                      元／平方米
                    </p>
                  )}
                  {extraFacts.length > 0 && (
                    <Descriptions
                      size="small"
                      column={2}
                      items={extraFacts.map(([label, value]) => ({
                        key: label,
                        label,
                        children: value,
                      }))}
                    />
                  )}
                  <p>{property.description}</p>
                  {(
                    [
                      ["房源详情链接", details?.listingUrl],
                      ["VR 看房链接", details?.vrUrl],
                    ] as const
                  ).map(
                    ([label, url]) =>
                      url && (
                        <p key={label}>
                          <Typography.Text copyable={{ text: url }}>
                            {label}
                          </Typography.Text>
                        </p>
                      ),
                  )}
                  <div className="property-tags">
                    {property.sellingPoints.map((p) => (
                      <span key={p}>{p}</span>
                    ))}
                  </div>
                  <p className="muted">
                    <MapPin size={14} /> {property.city} {property.district} ·
                    资料核验 {formatDate(property.lastVerifiedAt)}
                  </p>
                </div>
              </div>
            ),
          },
          {
            key: "materials",
            label: "制作素材",
            children: (
              <>
                {" "}
                <section className="panel detail-info">
                  <h2>房源素材</h2>
                  <p className="muted">
                    {material.data?.scenes.length ||
                      property.panoramas?.length ||
                      0}{" "}
                    张 VR 全景图
                  </p>
                  <div className="asset-grid">
                    {(material.data?.scenes.length
                      ? material.data.scenes.map((s) => s.url)
                      : property.panoramas || []
                    ).map((image, i) => (
                      <img
                        key={`${image}-${i}`}
                        src={image}
                        alt={`房源图片 ${i + 1}`}
                      />
                    ))}
                  </div>
                  {!!material.data?.references?.length && (
                    <>
                      <p className="muted">仅供文案参考的图片</p>
                      <div className="asset-grid">
                        {material.data.references.map((reference) => (
                          <img
                            key={reference.id}
                            src={reference.url}
                            alt={reference.room}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  {property.sample ? (
                    <p className="muted">
                      内置素材已就绪，可直接创建视频任务。
                    </p>
                  ) : window.desktop ? (
                    <>
                      <p className="muted">
                        保存新的如视看房链接后，会自动导入该空间的全部全景图。
                        如需重试，可使用「导入 VR 空间」。
                      </p>
                      <div
                        style={{ display: "flex", gap: 12, flexWrap: "wrap" }}
                      >
                        <Button
                          loading={importing}
                          disabled={!details?.vrUrl}
                          onClick={() => void addMaterial("spatial")}
                        >
                          导入 VR 空间
                        </Button>
                        <Button
                          loading={importing}
                          onClick={() => void addMaterial("panorama")}
                        >
                          添加 VR 全景图
                        </Button>
                        <Button
                          loading={importing}
                          onClick={() => void addMaterial("reference")}
                        >
                          添加户型图／参考图
                        </Button>
                        <Button
                          type="primary"
                          onClick={() =>
                            navigate(`/studio?propertyId=${property.id}`)
                          }
                        >
                          制作视频
                        </Button>
                      </div>
                    </>
                  ) : isLive ? (
                    <p className="muted">
                      请在桌面端添加 VR 全景原图和户型参考图。
                    </p>
                  ) : (
                    <Upload
                      accept="image/*,video/*"
                      showUploadList={false}
                      beforeUpload={async (file) => {
                        if (file.size > 100 * 1024 * 1024) {
                          message.error("单个演示文件最大100 MB");
                          return false;
                        }
                        await demoApi.updateProperty(property.id, {
                          videoCount:
                            property.videoCount +
                            (file.type.startsWith("video/") ? 1 : 0),
                          importStatus: "ready",
                        });
                        message.info(
                          `已登记 ${file.name} 的演示素材信息，文件未上传或保存`,
                        );
                        return false;
                      }}
                    >
                      <Button icon={<Plus size={16} />}>添加演示素材</Button>
                    </Upload>
                  )}
                </section>
              </>
            ),
          },
          {
            key: "tasks",
            label: "关联任务",
            children: (
              <>
                {" "}
                <section className="panel detail-info">
                  <h2>关联生成任务</h2>
                  {tasks.length ? (
                    tasks.map((task) => (
                      <Link
                        to={`/studio/tasks/${task.id}`}
                        className="related-task"
                        key={task.id}
                      >
                        <span>
                          {task.configSnapshot.videoMode === "avatar"
                            ? "经纪人露脸"
                            : "纯口播"}
                          <small>{formatDate(task.createdAt)}</small>
                        </span>
                        <StatusTag status={task.status} />
                      </Link>
                    ))
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="还没有生成任务"
                    />
                  )}
                </section>
              </>
            ),
          },
        ]}
      />
      {editing && (
        <PropertyForm property={property} onClose={() => setEditing(false)} />
      )}
    </>
  );
}
