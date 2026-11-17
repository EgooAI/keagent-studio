import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Input, Modal, Tag } from "antd";
import {
  demoApi,
  searchBeikeHouses,
  serviceRequest,
} from "@keagent/api-client";
import type { BeikeHouse, BeikeSearchResult } from "@keagent/shared-types";
import { beikeHouseToPropertyInput } from "../lib/beike";
import "./beike-import.css";

type BeikeCliStatus = {
  available: boolean;
  configured: boolean;
  reason: "not_configured" | "ready";
};

export function BeikeImportModal({
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
  const [result, setResult] = useState<BeikeSearchResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<"search" | "import" | null>(null);
  const status = useQuery({
    queryKey: ["beike-cli-status"],
    enabled: open,
    retry: false,
    queryFn: async () =>
      window.desktop
        ? ((await window.desktop.request("beikeCli.status")) as BeikeCliStatus)
        : serviceRequest<BeikeCliStatus>("/v1/beike-cli/status", {}),
  });

  async function runSearch() {
    if (pending) return;
    if (!city.trim() || !query.trim()) {
      message.warning(!city.trim() ? "请输入城市" : "请输入搜索条件");
      return;
    }
    setPending("search");
    try {
      const next = await searchBeikeHouses(city.trim(), query.trim());
      setResult(next);
      setSelected([]);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function importSelected() {
    if (pending || !result || !selected.length) return;
    const chosen = [...result.houses, ...result.overBudget].filter((house) =>
      selected.includes(house.id),
    );
    setPending("import");
    try {
      const failedIds: string[] = [];
      for (const house of chosen) {
        try {
          await demoApi.createProperty(
            beikeHouseToPropertyInput(house, result.city),
          );
        } catch {
          failedIds.push(house.id);
        }
      }
      const imported = chosen.length - failedIds.length;
      setSelected(failedIds);
      if (!failedIds.length) setResult(undefined);
      if (failedIds.length)
        message.warning(`${failedIds.length} 套未导入（可能已存在）`);
      if (imported) {
        message.success(`已导入 ${imported} 套贝壳房源`);
        await queryClient.invalidateQueries(
          { queryKey: ["workspace"] },
          { cancelRefetch: false },
        );
      }
    } finally {
      setPending(null);
    }
  }

  if (status.data?.reason !== "ready") {
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
              : "云端尚未配置贝壳 CLI，暂不能自动找房。"}
        </p>
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
      width={710}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            loading={pending === "import"}
            disabled={!selected.length || pending === "search"}
            onClick={importSelected}
          >
            导入选中（{selected.length}）
          </Button>
        </>
      }
    >
      <form
        className="beike-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <label>
          <span>城市</span>
          <Input
            value={city}
            onChange={(event) => setCity(event.target.value)}
            disabled={!!pending}
          />
        </label>
        <label>
          <span>搜索条件</span>
          <Input
            value={query}
            placeholder="例如：望京 两居 500万以内"
            onChange={(event) => setQuery(event.target.value)}
            disabled={!!pending}
          />
        </label>
        <Button
          type="primary"
          htmlType="submit"
          loading={pending === "search"}
          disabled={pending === "import"}
        >
          搜索
        </Button>
      </form>
      {result && (
        <>
          <p className="beike-summary" role="status">
            召回 {result.totalRecalled} 套，展示 {result.returned} 套
            {result.strictBudgetWan != null &&
              `（已按 ${result.strictBudgetWan} 万严格过滤）`}
          </p>
          {result.houses.length || result.overBudget.length ? (
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
              {!!result.overBudget.length && (
                <Alert
                  className="beike-budget-warning"
                  type="warning"
                  showIcon
                  title={`${result.overBudget.length} 套超过预算，已单独列出`}
                />
              )}
              {result.overBudget.map((house) => (
                <HouseRow
                  key={house.id}
                  house={house}
                  overBudget
                  selected={selected.includes(house.id)}
                />
              ))}
            </Checkbox.Group>
          ) : (
            <p className="beike-empty">没有符合条件的结果，请调整搜索条件。</p>
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
