import { useRef, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import { douyinDesktop, useDouyinDesktop } from "../lib/douyin";

export default function ChannelsVerification() {
  const { data } = useDouyinDesktop(false);
  const accountId = data?.channelsVerificationAccountId;
  if (!accountId) return null;
  return (
    <VerificationTask
      key={accountId + (data.activeRecord?.id ?? "")}
      accountId={accountId}
      title={
        data.activeRecord?.accountId === accountId
          ? data.activeRecord.title
          : undefined
      }
    />
  );
}

function VerificationTask({
  accountId,
  title,
}: {
  accountId: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState("");
  const [error, setError] = useState(false);
  const request = useRef(0);
  async function showCode() {
    const current = ++request.current;
    setOpen(true);
    setError(false);
    setImage("");
    try {
      const result = await douyinDesktop<{ image: string }>(
        "channels.verification",
        { accountId },
      );
      if (!result.image.startsWith("data:image/png;base64,")) throw new Error();
      if (request.current === current) setImage(result.image);
    } catch {
      if (request.current === current) setError(true);
    }
  }
  function close() {
    ++request.current;
    setOpen(false);
    setImage("");
  }
  return (
    <>
      <Alert
        type="warning"
        showIcon
        title="视频号发布等待实名验证"
        description={
          title
            ? `请管理员为《${title}》扫码。验证通过后将继续发布。`
            : "请管理员扫码，验证通过后将继续发布。"
        }
        action={<Button onClick={() => void showCode()}>查看验证二维码</Button>}
      />
      <Modal
        title="微信视频号实名验证"
        centered
        open={open}
        onCancel={close}
        footer={<Button onClick={close}>返回工作台</Button>}
        destroyOnHidden
      >
        {error ? (
          <Alert
            type="warning"
            showIcon
            title="暂时无法读取验证二维码"
            action={
              <Button size="small" onClick={() => void showCode()}>
                重新获取
              </Button>
            }
          />
        ) : image ? (
          <div className="channels-verification-code">
            <img src={image} alt="当前发布任务的视频号实名验证二维码" />
            <p>请管理员使用微信扫码并按手机提示完成验证。</p>
            <Button type="link" onClick={() => void showCode()}>
              刷新二维码
            </Button>
          </div>
        ) : (
          <Spin aria-label="正在读取二维码" />
        )}
      </Modal>
    </>
  );
}
