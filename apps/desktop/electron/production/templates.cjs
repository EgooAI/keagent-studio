const crypto = require("node:crypto");
const domain = require("../panorama/domain.cjs");
const runtimeFields = new Set([
  "templateId",
  "materialMode",
  "voice",
  "avatarId",
  "openingClip",
  "openingPhoto",
  "openingLocation",
  "roomOpening",
  "leadSceneId",
  "coverSceneId",
  "coverTitle",
  "agentName",
  "agentContact",
]);
function save(state, input) {
  const name = domain.text(input.name, "模板名称", 60);
  const previous = input.id
    ? state.templates.find((t) => t.id === input.id)
    : undefined;
  domain.ensure(!input.id || previous, "模板不存在或不属于当前账号");
  domain.ensure(
    !previous || input.version === previous.version,
    "模板已更新，请刷新后重试",
  );
  domain.ensure(previous || state.templates.length < 50, "最多保存50个模板");
  const config = domain.config(input.config, state.templates);
  const template = {
    id: previous?.id || `user-${crypto.randomUUID()}`,
    version: (previous?.version || 0) + 1,
    name,
    config: Object.fromEntries(
      Object.entries(config).filter(([key]) => !runtimeFields.has(key)),
    ),
    updatedAt: new Date().toISOString(),
  };
  state.templates = [
    template,
    ...state.templates.filter((t) => t.id !== template.id),
  ];
  return template;
}
module.exports = { save };
