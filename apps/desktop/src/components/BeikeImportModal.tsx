import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Checkbox,
  Input,
  Modal,
  Segmented,
  Select,
  Tag,
} from "antd";
import { ChevronDown, Search } from "lucide-react";
import {
  demoApi,
  getBeikeHouseDetail,
  searchBeikeHouses,
  serviceRequest,
} from "@keagent/api-client";
import type {
  BeikeDetailResult,
  BeikeHouse,
  BeikeSearchResult,
  Property,
} from "@keagent/shared-types";
import {
  beikeHouseToPropertyInput,
  supplementBeikeProperty,
} from "../lib/beike";
import "./beike-import.css";

type BeikeCliStatus = {
  available: boolean;
  configured: boolean;
  reason: "not_configured" | "ready";
};

const cityOptions = [
  "北京",
  "上海",
  "广州",
  "深圳",
  "杭州",
  "成都",
  "重庆",
  "武汉",
  "南京",
  "苏州",
  "天津",
  "西安",
  "长沙",
  "郑州",
  "合肥",
  "青岛",
].map((value) => ({ value }));

const layoutOptions = [
  { value: "", label: "不限" },
  ...["一居", "两居", "三居", "四居", "五居及以上"].map((value) => ({
    value,
    label: value,
  })),
];

export function BeikeImportModal({
  open,
  properties,
  onClose,
  onManual,
}: {
  open: boolean;
  properties: Property[];
  onClose: () => void;
  onManual: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const formId = useId();
  const [mode, setMode] = useState<"conditions" | "number">("conditions");
  const [source, setSource] = useState<"cli" | "browser">("cli");
  const [city, setCity] = useState("北京");
  const [propertyNumber, setPropertyNumber] = useState("");
  const [location, setLocation] = useState("");
  const [layout, setLayout] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [result, setResult] = useState<BeikeSearchResult | BeikeDetailResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<"search" | "import" | null>(null);
  const byNumber = mode === "number";
  const browserQuery = byNumber && source === "browser" && !!window.desktop;
  const waitingForBrowser = browserQuery && pending === "search";
  const searchResult = result && "overBudget" in result ? result : undefined;
  const overBudget = searchResult?.overBudget ?? [];
  const hasHouses = !!(result?.houses.length || overBudget.length);
  const matchedHouse = byNumber ? result?.houses[0] : undefined;
  const existing =
    browserQuery && matchedHouse
      ? properties.find(
          (p) => !p.sample && p.propertyNumber === matchedHouse.id,
        )
      : undefined;
  const status = useQuery({
    queryKey: ["beike-cli-status"],
    enabled: open,
    retry: false,
    queryFn: async () =>
      window.desktop
        ? ((await window.desktop.request("beikeCli.status")) as BeikeCliStatus)
        : serviceRequest<BeikeCliStatus>("/v1/beike-cli/status", {}),
  });

  function clearResults() {
    setResult(undefined);
    setSelected([]);
  }

  async function runSearch() {
    if (pending) return;
    const searchCity = city.trim();
    const area = location.trim();
    const budget = maxPrice.trim().normalize("NFKC");
    const budgetAmount = Number(budget);
    const id = propertyNumber.normalize("NFKC").trim();
    if (!searchCity) {
      message.warning("请输入城市");
      return;
    }
    if (byNumber && !/^\d+$/.test(id)) {
      message.warning("请输入一个纯数字的贝壳房源号");
      return;
    }
    if (!byNumber && !area) {
      message.warning("请输入区域、商圈或小区");
      return;
    }
    if (
      !byNumber &&
      budget &&
      (!/^\d+(?:\.\d+)?$/.test(budget) ||
        budgetAmount <= 0 ||
        !Number.isFinite(budgetAmount))
    ) {
      message.warning("最高总价请输入大于 0 的数字，例如 500");
      return;
    }
    const query = [area, layout, budget && `${budget}万以内`]
      .filter(Boolean)
      .join(" ");
    setPending("search");
    if (byNumber) clearResults();
    try {
      if (byNumber) {
        const next = browserQuery
          ? ((await window.desktop!.request("beikeBrowser.detail", [
              { city: searchCity, number: id },
            ])) as BeikeDetailResult)
          : await getBeikeHouseDetail(searchCity, [id]);
        const match = next.houses.find((house) => house.id === id);
        const houses = match ? [match] : [];
        setResult({ ...next, houses, returned: houses.length });
        setSelected(match ? [match.id] : []);
      } else {
        setResult(await searchBeikeHouses(searchCity, query));
        setSelected([]);
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPending(null);
    }
  }

  function fillExample(withFilters: boolean) {
    setCity("北京");
    setLocation("望京");
    setLayout(withFilters ? "两居" : "");
    setMaxPrice(withFilters ? "500" : "");
  }

  async function importSelected() {
    if (pending || !result || !selected.length) return;
    const chosen = [...result.houses, ...overBudget].filter((house) =>
      selected.includes(house.id),
    );
    setPending("import");
    try {
      const failedIds: string[] = [];
      for (const house of chosen) {
        try {
          const input = beikeHouseToPropertyInput(house, result.city);
          if (existing && existing.propertyNumber === house.id) {
            const workspace = await demoApi.getWorkspace();
            const current = workspace.properties.find(
              (p) => p.id === existing.id && p.propertyNumber === house.id,
            );
            if (!current) throw new Error("原房源已变更，请重新查询");
            await demoApi.updateProperty(
              current.id,
              supplementBeikeProperty(current, input),
            );
          } else {
            await demoApi.createProperty(input);
          }
        } catch {
          failedIds.push(house.id);
        }
      }
      const imported = chosen.length - failedIds.length;
      setSelected(failedIds);
      if (!failedIds.length) setResult(undefined);
      if (failedIds.length)
        message.warning(
          existing
            ? "房源资料补全失败，请重新查询后重试。"
            : `${failedIds.length} 套未导入（可能已存在）`,
        );
      if (imported) {
        message.success(
          existing ? "已补全房源资料" : `已导入 ${imported} 套贝壳房源`,
        );
        await queryClient.invalidateQueries(
          { queryKey: ["workspace"] },
          { cancelRefetch: false },
        );
      }
    } finally {
      setPending(null);
    }
  }

  if (status.data?.reason !== "ready" && !browserQuery) {
    return (
      <Modal
        className="beike-import-modal"
        centered
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
            : status.isError
              ? "暂时无法连接贝壳找房，请重试。"
              : "云端尚未配置贝壳 CLI。"}
        </p>
        {window.desktop && (
          <Button
            onClick={() => {
              setMode("number");
              setSource("browser");
              clearResults();
            }}
          >
            使用浏览器按房源号查询
          </Button>
        )}
        {status.isError && (
          <Button
            loading={status.isFetching}
            onClick={() => void status.refetch()}
          >
            重试
          </Button>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      className="beike-import-modal"
      centered
      title="从贝壳找房"
      open={open}
      width={820}
      closable={!waitingForBrowser}
      keyboard={!waitingForBrowser}
      mask={{ closable: !waitingForBrowser }}
      onCancel={onClose}
      footer={
        <>
          <Button disabled={waitingForBrowser} onClick={onClose}>
            关闭
          </Button>
          <Button
            type={selected.length ? "default" : "primary"}
            htmlType="submit"
            form={formId}
            icon={<Search size={17} />}
            loading={pending === "search"}
            disabled={pending === "import"}
          >
            {byNumber ? "查询房源" : "搜索房源"}
          </Button>
          {hasHouses && (
            <Button
              type={selected.length ? "primary" : "default"}
              loading={pending === "import"}
              disabled={!selected.length || pending === "search"}
              onClick={importSelected}
            >
              {existing
                ? "补全已有房源"
                : byNumber
                  ? "导入这套房源"
                  : `导入选中（${selected.length}）`}
            </Button>
          )}
        </>
      }
    >
      <p className="beike-intro">选中房源后可导入房源中心。</p>
      <Segmented<typeof mode>
        className="beike-search-mode"
        aria-label="查找方式"
        value={mode}
        options={[
          { value: "conditions", label: "按条件搜索" },
          { value: "number", label: "按房源号查询" },
        ]}
        disabled={!!pending}
        onChange={(value) => {
          setMode(value);
          clearResults();
        }}
      />
      {byNumber && window.desktop && (
        <div className="beike-search-mode">
          <Segmented<"cli" | "browser">
            aria-label="房源号查询来源"
            value={source}
            disabled={!!pending}
            options={[
              {
                value: "cli",
                label: "贝壳 CLI",
                disabled: status.data?.reason !== "ready",
              },
              { value: "browser", label: "贝壳浏览器" },
            ]}
            onChange={(value) => {
              setSource(value);
              clearResults();
            }}
          />
        </div>
      )}
      {waitingForBrowser && (
        <p role="status">
          请在贝壳浏览器完成登录或人机验证。读取成功后会自动返回，关闭浏览器可取消查询。
        </p>
      )}
      <form
        id={formId}
        className="beike-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div className="beike-search-field">
          <label htmlFor={`${formId}-city`}>城市</label>
          <AutoComplete
            id={`${formId}-city`}
            value={city}
            onChange={(value) => {
              setCity(value);
              if (byNumber) clearResults();
            }}
            options={cityOptions}
            showSearch={{
              filterOption: (input, option) =>
                cityOptions.some(({ value }) => value === input.trim()) ||
                !!option?.value.includes(input.trim()),
            }}
            suffixIcon={<ChevronDown size={16} aria-hidden="true" />}
            virtual={false}
            aria-required="true"
            disabled={!!pending}
          />
        </div>
        {byNumber ? (
          <div className="beike-search-field">
            <label htmlFor={`${formId}-property-number`}>贝壳房源号</label>
            <Input
              id={`${formId}-property-number`}
              value={propertyNumber}
              inputMode="numeric"
              placeholder="如 101138285186"
              onChange={(event) => {
                setPropertyNumber(event.target.value);
                clearResults();
              }}
              aria-required="true"
              disabled={!!pending}
            />
          </div>
        ) : (
          <>
            <div className="beike-search-field">
              <label htmlFor={`${formId}-location`}>区域、商圈或小区</label>
              <Input
                id={`${formId}-location`}
                value={location}
                placeholder="如 望京、望京西园"
                onChange={(event) => setLocation(event.target.value)}
                aria-describedby={`${formId}-location-hint`}
                aria-required="true"
                disabled={!!pending}
              />
              <small id={`${formId}-location-hint`}>填一个地点就能搜。</small>
            </div>
            <div className="beike-search-field">
              <label htmlFor={`${formId}-layout`}>
                户型<span>（选填）</span>
              </label>
              <Select
                id={`${formId}-layout`}
                value={layout}
                options={layoutOptions}
                onChange={setLayout}
                virtual={false}
                disabled={!!pending}
              />
            </div>
            <div className="beike-search-field">
              <label htmlFor={`${formId}-price`}>
                最高总价<span>（选填）</span>
              </label>
              <Input
                id={`${formId}-price`}
                inputMode="decimal"
                value={maxPrice}
                placeholder="如 500"
                suffix={<span id={`${formId}-price-unit`}>万元</span>}
                onChange={(event) => setMaxPrice(event.target.value)}
                aria-describedby={`${formId}-price-unit`}
                disabled={!!pending}
              />
            </div>
            <div className="beike-examples">
              <span>点一下试填</span>
              <Button
                htmlType="button"
                autoInsertSpace={false}
                disabled={!!pending}
                onClick={() => fillExample(false)}
              >
                望京
              </Button>
              <Button
                htmlType="button"
                disabled={!!pending}
                onClick={() => fillExample(true)}
              >
                望京 · 两居 · 500万以内
              </Button>
            </div>
          </>
        )}
      </form>
      {result && (
        <>
          {searchResult && (
            <p className="beike-summary" role="status">
              召回 {searchResult.totalRecalled} 套，展示 {searchResult.returned}{" "}
              套
              {searchResult.strictBudgetWan != null &&
                `（已按 ${searchResult.strictBudgetWan} 万严格过滤）`}
            </p>
          )}
          {matchedHouse && (
            <p className="beike-summary" role="status">
              房源号 {matchedHouse.id}
              {browserQuery &&
                ` · ${result.city} ${matchedHouse.district || ""}`}
              {matchedHouse.status && ` · ${matchedHouse.status}`}
              {browserQuery &&
                ("vrUrl" in matchedHouse && matchedHouse.vrUrl
                  ? " · 含 VR 看房链接"
                  : " · 未提供可导入的 VR 链接")}
            </p>
          )}
          {hasHouses ? (
            <Checkbox.Group<string>
              className="beike-results"
              value={selected}
              onChange={setSelected}
              disabled={!!pending}
            >
              {result.houses.map((house) => (
                <HouseRow
                  key={house.id}
                  house={house}
                  selected={selected.includes(house.id)}
                />
              ))}
              {!!overBudget.length && (
                <Alert
                  className="beike-budget-warning"
                  type="warning"
                  showIcon
                  title={`${overBudget.length} 套超过预算，已单独列出`}
                />
              )}
              {overBudget.map((house) => (
                <HouseRow
                  key={house.id}
                  house={house}
                  overBudget
                  selected={selected.includes(house.id)}
                />
              ))}
            </Checkbox.Group>
          ) : (
            <p className="beike-empty" role="status">
              {byNumber
                ? "未找到该房源，请核对城市和贝壳房源号。"
                : "没有符合条件的结果，请调整搜索条件。"}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

function HouseRow({
  house,
  selected,
  overBudget,
}: {
  house: BeikeHouse;
  selected: boolean;
  overBudget?: boolean;
}) {
  return (
    <Checkbox
      className={`beike-house-row${selected ? " is-selected" : ""}`}
      value={house.id}
    >
      <span className="beike-house-body">
        <span className="beike-house-top">
          <strong>{house.community}</strong>
          {overBudget && <Tag color="orange">超预算</Tag>}
          <b className="beike-house-price">总价 {house.totalPriceWan} 万</b>
        </span>
        <small className="beike-house-meta">
          <span>
            {house.layout} · {house.areaSqm}㎡
          </span>
          <span>{house.title}</span>
        </small>
      </span>
    </Checkbox>
  );
}
