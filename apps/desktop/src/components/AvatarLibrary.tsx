import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Upload,
} from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { authRequest } from "@keagent/api-client";
import type { PersonalAvatar } from "@keagent/shared-types";
import {
  encodePhoto,
  photoBlobURL,
  useAvatarLibrary,
  validatePhotoFile,
} from "../lib/avatarLibrary";

export function AvatarLibraryPanel() {
  const query = useAvatarLibrary();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const key = useRef(crypto.randomUUID());
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await client.invalidateQueries({ queryKey: ["personal-avatars"] });
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "形象操作失败",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>我的人物形象</h2>
      <p>
        露脸视频必须使用本人上传的照片。上传一次后，在全景工厂选择自己的形象；每次制作由照片和讲解音频生成数字人开场。
      </p>
      <Space style={{ marginBottom: 20 }}>
        <Button
          type="primary"
          disabled={!query.data?.uploadEnabled || busy}
          onClick={() => {
            setName("");
            setFile(undefined);
            setAuthorized(false);
            key.current = crypto.randomUUID();
            setOpen(true);
          }}
        >
          上传本人照片
        </Button>
        <Button onClick={() => void query.refetch()}>刷新形象列表</Button>
      </Space>
      {query.isError && (
        <Alert
          type="error"
          title="无法读取本人形象"
          description={query.error.message}
        />
      )}
      {query.data && !query.data.uploadEnabled && (
        <Alert
          type="info"
          title="照片私有存储及数字人服务尚未配置"
          description="管理员配置服务后即可上传。露脸模式没有预置形象，必须先上传本人的照片；纯口播模式无需形象。"
          style={{ marginBottom: 20 }}
        />
      )}
      <div aria-busy={query.isPending}>
        {query.data?.avatars.length === 0 && (
          <Empty description="尚未上传本人照片" />
        )}
        {query.data?.avatars.map((avatar) => (
          <div
            key={avatar.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              padding: "18px 0",
              borderBottom: "1px solid #edf0f4",
            }}
          >
            <div>
              <strong>{avatar.name}</strong>{" "}
              <Tag color={avatar.status === "ready" ? "green" : "default"}>
                {avatar.status === "ready" ? "照片已保存" : "保存结果待核对"}
              </Tag>
              {avatar.error && <p>{avatar.error}</p>}
            </div>
            <Space wrap>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await authRequest("avatar.refresh", [{ id: avatar.id }]);
                  })
                }
              >
                刷新状态
              </Button>
              <Button
                disabled={busy || avatar.status !== "ready"}
                onClick={() =>
                  void act(async () => {
                    const result = await authRequest<{
                      photo: string;
                      mime: string;
                    }>("avatar.preview", [{ id: avatar.id }]);
                    setPreview(photoBlobURL(result.photo, result.mime));
                  })
                }
              >
                查看本人照片
              </Button>
              <Popconfirm
                title="移除此形象？"
                description="新任务将不能再使用此形象，已有成片保留。云端原照片不会自动删除。"
                onConfirm={() =>
                  act(async () => {
                    await authRequest("avatar.remove", [{ id: avatar.id }]);
                  })
                }
              >
                <Button
                  danger
                  disabled={busy || avatar.status === "submitting"}
                >
                  移除
                </Button>
              </Popconfirm>
            </Space>
          </div>
        ))}
      </div>
      <Modal
        open={open}
        title="上传本人照片"
        onCancel={() => !busy && setOpen(false)}
        closable={!busy}
        maskClosable={!busy}
        okText="保存本人形象"
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        onOk={() => {
          if (!file || !authorized || !name.trim()) {
            void message.warning("请填写名称、选择本人照片并确认授权");
            return;
          }
          void act(async () => {
            const created = await authRequest<PersonalAvatar>("avatar.create", [
              {
                name: name.trim(),
                photo: await encodePhoto(file),
                authorized,
                requestKey: key.current,
              },
            ]);
            setOpen(false);
            setFile(undefined);
            void message.info(
              created.status === "ready"
                ? "本人照片已保存，可在露脸模式中选择"
                : "保存结果待核对，请刷新状态，勿重复上传",
            );
          });
        }}
      >
        <Alert
          type="info"
          title="使用清晰的单人正面照片"
          description="仅支持 JPEG / PNG，不超过5 MB、4096×4096像素。照片存入私有存储，并在制作时提供给火山数字人服务。"
          style={{ marginBottom: 20 }}
        />
        <Form layout="vertical" disabled={busy}>
          <Form.Item label="形象名称" required>
            <Input
              maxLength={40}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                key.current = crypto.randomUUID();
              }}
            />
          </Form.Item>
          <Form.Item label="本人照片" required>
            <Upload
              accept="image/jpeg,image/png"
              showUploadList={false}
              beforeUpload={(selected) => {
                try {
                  validatePhotoFile(selected);
                  setFile(selected);
                  key.current = crypto.randomUUID();
                } catch (error) {
                  void message.error(
                    error instanceof Error ? error.message : "照片无效",
                  );
                }
                return false;
              }}
            >
              <Button>{file?.name || "选择本人照片"}</Button>
            </Upload>
          </Form.Item>
          <Checkbox
            checked={authorized}
            onChange={(event) => setAuthorized(event.target.checked)}
          >
            我确认这是本人照片，同意保存并用于生成本人的数字人视频。
          </Checkbox>
        </Form>
      </Modal>
      <Modal
        open={!!preview}
        footer={null}
        title="本人上传的照片"
        onCancel={() => setPreview("")}
      >
        <img
          src={preview}
          alt="本人上传的形象照片"
          style={{ width: "100%", maxHeight: 500, objectFit: "contain" }}
        />
      </Modal>
    </>
  );
}
