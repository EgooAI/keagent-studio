import { useState, type ReactNode } from "react";
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
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Upload,
} from "antd";
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  FileUp,
  LayoutGrid,
  List,
  Pencil,
  Play,
  Plus,
  Upload as UploadIcon,
} from "lucide-react";
import { demoApi, isLive } from "@keagent/api-client";
import type { ImportResult, Property } from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { PageHeader, PropertyPhoto, formatPrice } from "../components/common";
import { parseCsv, propertyNumbersFromRows } from "../lib/importFile";
import { request as productionRequest } from "../components/panoramaClient";
import {
  PropertyForm,
  PropertyVrLinkForm,
  savePropertyVrLink,
  importPropertyVr,
} from "../components/PropertyForm";
import { BeikeImportModal } from "../components/BeikeImportModal";
import { PropertyInfoTab } from "../components/PropertyInfoTab";
import { PropertyMaterialsTab } from "../components/PropertyMaterialsTab";
import { PropertyRelatedTasks } from "../components/PropertyRelatedTasks";
import { DeletePropertyButton } from "../components/DeletePropertyButton";
import type { PanoramaScene } from "@keagent/shared-types";
import {
  demoPropertyActivity,
  emptyActivity,
  loadPropertyActivity,
} from "../lib/propertyActivity";
import "./property-library.css";
import "./property-cards.css";
import "./property-detail.css";

export default function PropertiesPage() {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const activity = useQuery({
    queryKey: ["douyin", "property-activity"],
    queryFn: loadPropertyActivity,
    enabled: isLive && !!data?.properties.length,
    refetchInterval: 30000,
    retry: false,
  });
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [view, setView] = useState("grid");
  const [searchParams] = useSearchParams();
  const [importOpen, setImportOpen] = useState(
    searchParams.get("import") === "1",
  );
  const [manualOpen, setManualOpen] = useState(false);
  if (!data) return null;
  const stats = isLive ? activity.data : demoPropertyActivity(data);
  const pendingLabel = activity.isError ? "统计暂时无法获取" : "统计加载中";
  const statusLabels = {
    published: "已发布过",
    unpublished: "未发布过",
    scheduled: "已排期",
  };
  const statFor = (id: string) => stats?.get(id) ?? emptyActivity;
  const statusLabel = (id: string) =>
    stats ? statusLabels[statFor(id).status] : pendingLabel;
  const videoLabel = (id: string) =>
    stats ? `已生成 ${statFor(id).videos} 条视频` : pendingLabel;
  const counts = {
    all: data.properties.length,
    published: 0,
    unpublished: 0,
    scheduled: 0,
  };
  if (stats) for (const p of data.properties) counts[statFor(p.id).status]++;
  const filtered =
    filter === "all"
      ? data.properties
      : data.properties.filter((p) => stats && statFor(p.id).status === filter);
  const waitingForFilter = !stats && filter !== "all";
  const pageSize = 8;
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const pageRows = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const pagination = {
    current: currentPage,
    pageSize,
    total: filtered.length,
    onChange: setPage,
    showSizeChanger: false,
    hideOnSinglePage: true,
  };
  return (
    <div className="studio-index-page property-library">
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
      <div className="panel library-toolbar">
        <div className="library-filters" role="group" aria-label="房源发布分类">
          {[
            ["all", "全部房源"],
            ["unpublished", "未发布过"],
            ["published", "已发布过"],
            ...(counts.scheduled || filter === "scheduled"
              ? [["scheduled", "已排期"]]
              : []),
          ].map(([key, label]) => (
            <button
              type="button"
              disabled={key !== "all" && !stats && !!counts.all}
              aria-pressed={filter === key}
              key={key}
              onClick={() => {
                setFilter(key);
                setPage(1);
              }}
            >
              {label}
              <span>
                {key === "all" || stats || !counts.all
                  ? counts[key as keyof typeof counts]
                  : "—"}
              </span>
            </button>
          ))}
        </div>
        <div className="library-tools">
          <Segmented
            aria-label="房源显示方式"
            value={view}
            onChange={(v) => setView(String(v))}
            options={[
              {
                value: "grid",
                title: "卡片视图",
                label: (
                  <>
                    <LayoutGrid size={18} aria-hidden="true" />
                    <span className="sr-only">卡片视图</span>
                  </>
                ),
              },
              {
                value: "table",
                title: "表格视图",
                label: (
                  <>
                    <List size={18} aria-hidden="true" />
                    <span className="sr-only">表格视图</span>
                  </>
                ),
              },
            ]}
          />
        </div>
      </div>
      {activity.isError && (
        <Alert
          type="warning"
          showIcon
          title="房源统计暂时无法获取"
          action={<Button onClick={() => void activity.refetch()}>重试</Button>}
        />
      )}
      <div className="library-results">
        <strong role="status">
          {waitingForFilter ? pendingLabel : `共 ${filtered.length} 套房源`}
        </strong>
        {!isLive && <span>房源资料为演示内容，不构成真实交易信息</span>}
      </div>
      {waitingForFilter ? null : !filtered.length ? (
        <div className="panel empty-panel">
          <Empty
            description={filter === "all" ? "暂无房源" : "该分类下暂无房源"}
          />
        </div>
      ) : view === "grid" ? (
        <div className="property-grid">
          {pageRows.map((property) => (
            <article className="property-card" key={property.id}>
              <Link to={`/properties/${property.id}`} className="card-cover">
                <span className="sr-only">{property.community}房源详情</span>
                <span className="card-cover-placeholder" aria-hidden="true">
                  <Building2 size={28} strokeWidth={1.5} />
                  暂无房源封面
                </span>
                {property.image && (
                  <img
                    key={property.image}
                    src={property.image}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                )}
                <span className="card-cover-state">
                  {statusLabel(property.id)}
                </span>
                <span className="card-cover-videos">
                  <Play size={12} fill="currentColor" aria-hidden="true" />
                  {videoLabel(property.id)}
                </span>
              </Link>
              <div className="card-property-info">
                <div className="card-property-title">
                  <h2>
                    <Link to={`/properties/${property.id}`}>
                      {property.community}
                    </Link>
                  </h2>
                  <strong>
                    {property.sample
                      ? "测试样例"
                      : formatPrice(property.priceCents)}
                  </strong>
                </div>
                <p className="card-property-summary">
                  {[
                    property.layout,
                    property.sample ? "两张原全景图" : `${property.areaSqm} m²`,
                    property.district,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="card-property-description">{property.title}</p>
                <p className="card-property-number">
                  房源号 {property.propertyNumber}
                </p>
                {property.sellingPoints.length > 0 && (
                  <ul className="card-property-tags" aria-label="房源卖点">
                    {property.sellingPoints.slice(0, 3).map((point, index) => (
                      <li key={index}>{point}</li>
                    ))}
                  </ul>
                )}
              </div>
              <footer className="card-property-footer">
                <span
                  className="card-material-state"
                  data-status={property.importStatus}
                >
                  {property.importStatus === "ready"
                    ? "素材已就绪"
                    : "待补充素材"}
                </span>
                <DeletePropertyButton property={property} compact iconOnly />
                <Link
                  to={`/studio/create?propertyId=${property.id}`}
                  className="card-create-link"
                >
                  创建视频 <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel library-table">
          <Table
            rowKey="id"
            dataSource={filtered}
            scroll={{ x: 720 }}
            pagination={pagination}
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
                className: "library-table-price",
                render: (_, p: Property) =>
                  p.sample ? "测试样例" : formatPrice(p.priceCents),
              },
              {
                title: "成片",
                render: (_, p: Property) => videoLabel(p.id),
              },
              {
                title: "发布",
                render: (_, p: Property) => <Tag>{statusLabel(p.id)}</Tag>,
              },
              {
                title: "操作",
                align: "right",
                render: (_, p: Property) => (
                  <div className="library-table-actions">
                    <DeletePropertyButton property={p} compact iconOnly />
                    <Link to={`/studio/create?propertyId=${p.id}`}>
                      创建视频 <ArrowUpRight size={14} aria-hidden="true" />
                    </Link>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}
      {view === "grid" && (
        <Pagination
          className="library-grid-pagination"
          align="end"
          {...pagination}
        />
      )}
      {isLive ? (
        <BeikeImportModal
          properties={data.properties}
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

type MaterialImportKind = "panorama" | "reference";

export function PropertyDetailPage() {
  const { propertyId } = useParams();
  const [detailParams] = useSearchParams();
  const { data } = useWorkspace();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [vrLookupError, setVrLookupError] = useState<{
    id: string;
    message: string;
  }>();
  const [retryVrId, setRetryVrId] = useState<string>();
  const [addingVrLink, setAddingVrLink] = useState(false);
  const [activeImport, setActiveImport] = useState<
    MaterialImportKind | "fetchVr" | "importVr" | null
  >(null);
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
  const addMaterial = async (kind: MaterialImportKind) => {
    setActiveImport(kind);
    try {
      const value = await productionRequest<{ count: number }>(
        "property-import",
        { propertyId, kind },
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
      setActiveImport(null);
    }
  };
  async function importSavedVr(id: string) {
    setActiveImport("importVr");
    try {
      const count = await importPropertyVr(id, queryClient);
      setRetryVrId(undefined);
      message.success(`已保存房源 VR 链接，已导入 ${count} 张 VR 全景图`);
    } catch (error) {
      setRetryVrId(id);
      message.warning(
        `链接已保存，全景图导入失败（${error instanceof Error ? error.message : "请稍后重试"}）。`,
        8,
      );
    } finally {
      setActiveImport(null);
    }
  }
  if (!data) return null;
  if (!property)
    return (
      <Empty description="房源不存在">
        <Button onClick={() => navigate("/properties")}>返回房源中心</Button>
      </Empty>
    );
  const tasks = data.tasks.filter((t) => t.propertyId === property.id);
  const panoramas = material.data?.scenes.length
    ? material.data.scenes.map((scene) => scene.url)
    : (property.panoramas ?? []);
  const hasPanoramas = panoramas.length > 0;
  const materialReadError =
    material.isError &&
    !material.error.message.includes("没有这套房源的本机素材记录");
  let materialReadFeedback: ReactNode;
  if (material.isLoading && !hasPanoramas) {
    materialReadFeedback = (
      <Skeleton
        active
        title={false}
        paragraph={{ rows: 2 }}
        aria-label="正在读取房源素材"
      />
    );
  } else if (materialReadError) {
    materialReadFeedback = (
      <Alert
        type="warning"
        showIcon
        title="本机素材暂时无法读取"
        description={material.error.message}
        action={
          <Button size="small" onClick={() => void material.refetch()}>
            重新读取
          </Button>
        }
      />
    );
  }
  let materialNote: string | undefined;
  let materialActions: ReactNode;
  if (property.sample) {
    if (hasPanoramas) materialNote = "内置素材已就绪，可直接创建视频任务。";
  } else if (window.desktop) {
    materialNote = hasPanoramas
      ? "已添加 VR 全景图，可用于制作视频。"
      : "保存如视 VR 看房链接后会自动导入全景图，也可以直接添加本机图片。";
    materialActions = (
      <>
        <Button
          loading={activeImport === "fetchVr" || activeImport === "importVr"}
          disabled={
            material.isPending || materialReadError || activeImport !== null
          }
          onClick={async () => {
            setVrLookupError(undefined);
            setActiveImport("fetchVr");
            try {
              const link = (await window.desktop!.request("beikeBrowser.vr", [
                { city: property.city, number: property.propertyNumber },
              ])) as string;
              await savePropertyVrLink(property, link, queryClient);
              if (hasPanoramas) {
                message.success("已保存房源 VR 链接");
              } else {
                await importSavedVr(property.id);
              }
            } catch (error) {
              setVrLookupError({
                id: property.id,
                message:
                  error instanceof Error
                    ? error.message.replace(
                        /^Error invoking remote method 'identity:request': (?:Error: )?/,
                        "",
                      )
                    : "获取或保存 VR 链接失败",
              });
            } finally {
              setActiveImport(null);
            }
          }}
        >
          {activeImport === "fetchVr"
            ? "正在获取 VR 链接…"
            : activeImport === "importVr"
              ? "正在导入全景图…"
              : "获取房源 VR 链接"}
        </Button>
        {retryVrId === property.id && !hasPanoramas && (
          <Button
            disabled={
              activeImport !== null || material.isPending || materialReadError
            }
            onClick={() => void importSavedVr(property.id)}
          >
            重试导入全景图
          </Button>
        )}
        <Button
          disabled={
            hasPanoramas ||
            material.isPending ||
            materialReadError ||
            activeImport !== null
          }
          onClick={() => {
            setVrLookupError(undefined);
            setAddingVrLink(true);
          }}
        >
          添加房源 VR 链接
        </Button>
        <Button
          loading={activeImport === "panorama"}
          disabled={activeImport !== null}
          onClick={() => void addMaterial("panorama")}
        >
          添加 VR 全景图
        </Button>
        <Button
          loading={activeImport === "reference"}
          disabled={activeImport !== null}
          onClick={() => void addMaterial("reference")}
        >
          添加户型图／参考图
        </Button>
        <Button
          type="primary"
          onClick={() => navigate(`/studio?propertyId=${property.id}`)}
        >
          制作视频
        </Button>
      </>
    );
  } else if (isLive) {
    materialNote = "请在桌面端添加 VR 全景原图和户型参考图。";
  } else {
    materialActions = (
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
              property.videoCount + (file.type.startsWith("video/") ? 1 : 0),
            importStatus: "ready",
          });
          message.info(`已登记 ${file.name} 的演示素材信息，文件未上传或保存`);
          return false;
        }}
      >
        <Button icon={<Plus size={16} />}>添加演示素材</Button>
      </Upload>
    );
  }
  return (
    <div className="studio-index-page property-detail-page">
      <Link className="back-link" to="/properties">
        <ArrowLeft size={18} aria-hidden="true" /> 房源中心
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
              disabled={property.sample || activeImport !== null}
              icon={<Pencil size={16} aria-hidden="true" />}
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
              创建视频任务 <ArrowUpRight size={16} aria-hidden="true" />
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
        defaultActiveKey={
          detailParams.get("tab") === "materials" ? "materials" : "info"
        }
        items={[
          {
            key: "info",
            label: "房源资料",
            children: <PropertyInfoTab property={property} />,
          },
          {
            key: "materials",
            label: "制作素材",
            children: (
              <PropertyMaterialsTab
                panoramas={panoramas}
                references={material.data?.references ?? []}
                readFeedback={materialReadFeedback}
                note={
                  vrLookupError?.id === property.id ? (
                    <span role="status">{vrLookupError.message}</span>
                  ) : (
                    materialNote
                  )
                }
                actions={materialActions}
              />
            ),
          },
          {
            key: "tasks",
            label: "关联任务",
            children: <PropertyRelatedTasks tasks={tasks} />,
          },
        ]}
      />
      {editing && (
        <PropertyForm property={property} onClose={() => setEditing(false)} />
      )}
      {addingVrLink && (
        <PropertyVrLinkForm
          key={property.id}
          property={property}
          onClose={() => setAddingVrLink(false)}
        />
      )}
    </div>
  );
}
