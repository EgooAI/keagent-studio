import { APIError, BASE_ERROR_CODES, betterAuth } from "@app/auth-sdk/server";
import { admin, bearer, jwt } from "@app/auth-sdk/plugins";
import { Pool } from "pg";

const minPasswordLength = 8;
let instance;
export function getAuth() {
  if (instance) return instance;
  for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET"]) {
    if (!process.env[key]) throw new Error(`${key} 未配置`);
  }
  if (process.env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("服务端密钥至少 32 字符");
  instance = betterAuth({
    appName: "KeAgent Studio",
    database: new Pool({ connectionString: process.env.DATABASE_URL }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL || "http://127.0.0.1:18080",
    basePath: "/api/auth",
    trustedOrigins: (
      process.env.TRUSTED_ORIGINS ||
      "http://127.0.0.1:5174,http://127.0.0.1:5173"
    ).split(","),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength,
      revokeSessionsOnPasswordReset: true,
    },
    hooks: {
      async before(ctx) {
        const password = ctx.body?.password;
        if (
          ctx.path === "/admin/create-user" &&
          typeof password === "string" &&
          [...password].length < minPasswordLength
        ) {
          throw APIError.from(
            "BAD_REQUEST",
            BASE_ERROR_CODES.PASSWORD_TOO_SHORT,
          );
        }
      },
    },
    session: { cookieCache: { enabled: false } },
    plugins: [
      admin({ auditLog: true }),
      bearer({ requireSignature: true }),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
          rotationInterval: 60 * 60 * 24 * 30,
          gracePeriod: 600,
        },
        jwt: {
          issuer:
            process.env.JWT_ISSUER ||
            process.env.BETTER_AUTH_URL ||
            "http://127.0.0.1:18080",
          audience: process.env.JWT_AUDIENCE || "keagent-api",
          expirationTime: "5m",
          definePayload: ({ session }) => ({ sid: session.id }),
        },
      }),
    ],
  });
  return instance;
}

export async function identity(headers) {
  const value = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!value || value.user.banned) return null;
  return {
    userId: value.user.id,
    sessionId: value.session.id,
    name: value.user.name,
    email: value.user.email,
    role: value.user.role || "user",
  };
}
