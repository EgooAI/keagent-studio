import { App, Button } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { collectionApi } from "@keagent/api-client";

export default function OpenCommenterButton({
  accountId,
  workId,
  commentId,
  label,
  onOpen,
}: {
  accountId: string;
  workId: string;
  commentId: string;
  label: string;
  onOpen?: () => void;
}) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const open = useMutation({
    mutationFn: () =>
      collectionApi.commentContact({ accountId, workId, id: commentId }),
    onSuccess: (state) => {
      client.setQueryData(["douyin", "desktop"], state);
      onOpen?.();
    },
    onError: (error) => void message.error(error.message),
  });
  return (
    <Button type="link" loading={open.isPending} onClick={() => open.mutate()}>
      {label}
    </Button>
  );
}
