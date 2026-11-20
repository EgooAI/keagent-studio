import { getMigrations } from "@app/auth-sdk/migrations";
import { getAuth } from "./lib/auth.mjs";
const auth = getAuth();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (Boolean(email) !== Boolean(password))
  throw new Error("初始化管理员需要同时设置邮箱和密码。");
const minPasswordLength = auth.options.emailAndPassword.minPasswordLength;
if (password && password.length < minPasswordLength)
  throw new Error(`管理员初始密码至少需要 ${minPasswordLength} 个字符。`);

await (await getMigrations(auth.options)).runMigrations();
if (email && password) {
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email);
  if (!existing) {
    await auth.api.createUser({
      body: { email, password, name: "系统管理员", role: "admin" },
    });
    console.log("已创建初始化管理员。");
  } else {
    if (!existing.user.role?.split(",").includes("admin"))
      throw new Error("初始化邮箱已由普通账号使用，请指定另一邮箱。");
    console.log("管理员已存在，继续使用该账号。");
  }
}
console.log("认证迁移完成。");
process.exit(0);
