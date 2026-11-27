import { useId, useState } from "react";
import { Button, Input } from "antd";
import {
  channelsDescription,
  channelsShortTitle,
  channelsShortTitleIssue,
} from "@keagent/shared-types";

interface ChannelsCopyFieldsProps {
  title: string;
  description: string;
  hashtags: string[];
  shortTitle?: string;
  onShortTitleChange: (value: string | undefined) => void;
  labelPrefix?: string;
  disabled?: boolean;
}

export function ChannelsCopyFields({
  title,
  description,
  hashtags,
  shortTitle,
  onShortTitleChange,
  labelPrefix = "",
  disabled,
}: ChannelsCopyFieldsProps) {
  const id = useId();
  const [editingEmpty, setEditingEmpty] = useState(false);
  const generated = title.trim() ? channelsShortTitle(title) : "";
  const value = shortTitle ?? (editingEmpty ? "" : generated);
  const issue = channelsShortTitleIssue(shortTitle);

  return (
    <div className="channels-copy-fields">
      <div className="channels-short-title-heading">
        <label htmlFor={id}>短标题</label>
        {shortTitle !== undefined && (
          <Button
            type="link"
            size="small"
            disabled={disabled}
            aria-label={`${labelPrefix}恢复自动短标题`}
            onClick={() => onShortTitleChange(undefined)}
          >
            恢复自动生成
          </Button>
        )}
      </div>
      <Input
        id={id}
        aria-label={`${labelPrefix}短标题`}
        aria-invalid={!!issue}
        aria-describedby={`${id}-hint`}
        status={issue ? "error" : undefined}
        value={value}
        placeholder={generated || "根据描述首行自动生成"}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setEditingEmpty(next === "");
          onShortTitleChange(next || undefined);
        }}
        onBlur={() => setEditingEmpty(false)}
      />
      <small
        id={`${id}-hint`}
        className={issue ? "channels-copy-error" : undefined}
      >
        {issue ||
          (shortTitle === undefined
            ? "随描述首行自动生成，可修改"
            : "使用自定义短标题")}
      </small>
      <details className="channels-copy-preview">
        <summary>{labelPrefix}预览发布文案</summary>
        <div>{channelsDescription(title, description, hashtags)}</div>
      </details>
    </div>
  );
}
