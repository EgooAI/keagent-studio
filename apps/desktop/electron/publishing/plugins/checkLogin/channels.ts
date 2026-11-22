// The assistant hydrates userStore.finder from auth_data's active finderUser.
// userAttr is the operator and can manage more than one channel.
export function channelsSelf() {
  if (location.origin !== "https://channels.weixin.qq.com")
    return { status: "unknown" };
  const visible = (selector: string) =>
    Array.from(document.querySelectorAll(selector)).some(
      (element) => element.getClientRects().length > 0,
    );
  if (
    /\/login(?:\.html)?(?:\/|$)/i.test(location.pathname) ||
    visible(
      'iframe[src*="open.weixin.qq.com/connect/qrconnect"],iframe[src*="login-for-iframe"],.login-qrcode-wrap',
    )
  )
    return { status: "logged_out" };
  if (!/^\/platform(?:\/|$)/.test(location.pathname))
    return { status: "unknown" };
  const store = (
    window as Window & {
      _store?: {
        userStore?: {
          finderUsername?: unknown;
          finderNickname?: unknown;
          isExpired?: boolean;
        };
      };
    }
  )._store?.userStore;
  if (store?.isExpired) return { status: "expired" };
  const id = store?.finderUsername;
  if (typeof id !== "string" || !/^[\w.@-]{1,150}$/.test(id))
    return { status: "unknown" };
  return {
    status: "logged_in",
    id,
    nickname:
      typeof store?.finderNickname === "string"
        ? store.finderNickname.slice(0, 100)
        : undefined,
  };
}
