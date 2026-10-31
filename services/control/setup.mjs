import { getMigrations } from "@app/auth-sdk/migrations";
import { getAuth } from "./lib/auth.mjs";
const auth = getAuth();
await (await getMigrations(auth.options)).runMigrations();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (email && password) {
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email);
  if (!existing)
    await auth.api.createUser({
      body: { email, password, name: "系统管理员", role: "admin" },
    });
  else console.log("管理员已存在，未修改密码或权限。");
}
console.log("认证迁移完成。");
process.exit(0);
