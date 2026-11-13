// These functions execute in the original public viewer, using its existing SDK.
// They do not load, alter, or bypass the SDK's signed Work validation.
async function prepareViewer(shot, expected) {
  const deadline = Date.now() + 60000;
  let five;
  while (!five) {
    const instances = Object.values(window.__FIVE_DEBUG__?.instances || {});
    five = instances.find(
      (instance) => instance.work?.workCode === expected.code,
    );
    if (Date.now() > deadline)
      throw new Error("原始 VR 查看器未就绪或房源已变更");
    if (!five) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const previous = window.__keagentSpatial;
  if (previous) previous.manual = false;
  five.play();
  await five.ready({ tile: true });
  await five.model.loadedReady;
  if (!five.model.loaded || five.model.empty)
    throw new Error("真实空间模型未加载完成");
  const close = (a, b) =>
    a.length === b.length &&
    a.every((value, i) => Math.abs(value - b[i]) < 0.000001);
  const equalNodes = (a, b) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (
    five.work.observers.length !== expected.observers.length ||
    five.work.getURL(five.work.model?.file) !== expected.modelURL
  )
    throw new Error("原始 VR 模型与已导入房源不一致，请重新导入");
  if (
    !equalNodes(
      five.work.model.textures.map((url) => five.work.getURL(url)),
      expected.textureURLs,
    )
  )
    throw new Error("原始 VR 模型纹理已变更，请重新导入");
  for (const point of expected.observers) {
    const live = five.work.observers.find(
      (observer) => observer.panoIndex === point.index,
    );
    const q = point.quaternion;
    const quaternion = [q.x, q.y, q.z, q.w];
    if (
      !live ||
      !close(live.position.toArray(), point.position) ||
      (!close(live.quaternion.toArray(), quaternion) &&
        !close(
          live.quaternion.toArray(),
          quaternion.map((value) => -value),
        )) ||
      !equalNodes(live.accessibleNodes, point.accessible_nodes)
    )
      throw new Error("原始 VR 点位几何已变更，请重新导入");
    const images = expected.panoramas.find(
      (pano) => pano.index === point.index,
    );
    for (const face of ["right", "left", "up", "down", "front", "back"]) {
      if (five.work.getURL(live.images[face]) !== images[face])
        throw new Error("原始 VR 点位图片已变更，请重新导入");
    }
  }
  five.updateConfiguration({ panorama: { minFov: 30, maxFov: 140 } });
  await five.ready({ tile: true });
  await five.moveToPano(shot.from, {
    effect: "instant",
    longitude: (shot.yaw * Math.PI) / 180,
    latitude: 0,
    fov: shot.vFov,
  });
  await five.ready({ tile: true });
  await five.preloadPano({ workCode: five.work.workCode, panoIndex: shot.to });
  five.pause();
  const nativeNow = previous?.nativeNow || performance.now.bind(performance);
  const state = {
    five,
    nativeNow,
    clock: nativeNow(),
    epoch: Date.now() - nativeNow(),
    manual: true,
    started: false,
    start: 0,
    lastFrame: -1,
    shot,
    error: null,
  };
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => (state.manual ? state.clock : nativeNow()),
  });
  window.__keagentSpatial = state;
  void five
    .moveToPano(shot.to, {
      effect: "fly",
      duration: (shot.frames / shot.fps) * 1000,
      longitude: (shot.yaw * Math.PI) / 180,
      latitude: 0,
      fov: shot.vFov,
      moveStartCallback: () => {
        state.started = true;
        state.start = state.clock;
      },
      moveCancelCallback: () => {
        state.error = new Error("空间镜头被原始查看器中断");
      },
    })
    .catch((error) => {
      state.error = error;
    });
  while (!state.started) {
    if (state.error) throw state.error;
    if (Date.now() > deadline) throw new Error("空间镜头加载超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    position: five.camera.position.toArray(),
    fov: five.getCurrentState().fov,
  };
}

function captureFrame(index) {
  const state = window.__keagentSpatial;
  const { five, shot } = state;
  if (state.error) throw state.error;
  if (index !== state.lastFrame + 1 || index >= shot.frames)
    throw new Error("空间视频帧顺序无效");
  const time = (((index / (shot.frames - 1)) * shot.frames) / shot.fps) * 1000;
  const delta = state.start + time - state.clock;
  state.clock = state.start + time;
  five.updateTime(state.epoch + state.clock, delta);
  five.model.show();
  five.model.parameter.set({ opacity: 1, onlyDepth: false, modelAlpha: 1 });
  const pixels = five.getPixels({
    x: 0,
    y: 0,
    width: shot.width,
    height: shot.height,
    pixelRatio: 1,
    flipY: true,
    helperVisible: false,
    skipPanorama: true,
  });
  state.lastFrame = index;
  return { pixels: pixels.buffer, position: five.camera.position.toArray() };
}

module.exports = { prepareViewer, captureFrame };
