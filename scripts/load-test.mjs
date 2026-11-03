import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

export function summarize(samples, elapsedMs) {
  const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const successes = samples.filter((sample) => sample.ok);
  const percentile = (p) =>
    durations[Math.max(0, Math.ceil(durations.length * p) - 1)] || 0;
  const statuses = {};
  for (const sample of samples)
    statuses[sample.status] = (statuses[sample.status] || 0) + 1;
  return {
    requests: samples.length,
    successful: successes.length,
    unexpected: samples.filter((sample) => !sample.ok && sample.status !== 429)
      .length,
    rateLimited: statuses[429] || 0,
    statuses,
    elapsedMs: Math.round(elapsedMs),
    rps: +((samples.length / elapsedMs) * 1000).toFixed(1),
    successRps: +((successes.length / elapsedMs) * 1000).toFixed(1),
    p50: +percentile(0.5).toFixed(2),
    p95: +percentile(0.95).toFixed(2),
    p99: +percentile(0.99).toFixed(2),
    max: +(durations.at(-1) || 0).toFixed(2),
  };
}

export async function runPhase({
  name,
  concurrency,
  durationMs,
  operation,
  maxRequests = 100000,
}) {
  assert.ok(
    Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 200,
  );
  assert.ok(durationMs > 0 && durationMs <= 60000);
  const samples = [];
  const started = performance.now();
  const cpu = process.cpuUsage();
  let sequence = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      while (
        performance.now() - started < durationMs &&
        sequence < maxRequests
      ) {
        const iteration = sequence++;
        const requestStarted = performance.now();
        try {
          const result = await operation(worker, iteration);
          samples.push({ ms: performance.now() - requestStarted, ...result });
        } catch (error) {
          samples.push({
            ms: performance.now() - requestStarted,
            status: error.name,
            ok: false,
          });
        }
      }
    }),
  );
  const usage = process.cpuUsage(cpu);
  return {
    name,
    concurrency,
    ...summarize(samples, performance.now() - started),
    driverCpuMs: Math.round((usage.user + usage.system) / 1000),
  };
}

async function main() {
  loadEnvFile(".env.local");
  const originalURL = new URL(process.env.DATABASE_URL);
  assert.equal(originalURL.hostname, "127.0.0.1", "Local database required");
  assert.equal(originalURL.port, "55432");
  assert.equal(originalURL.pathname, "/keagent");
  const authURL = "http://127.0.0.1:18080";
  const goURL = "http://127.0.0.1:18081";
  for (const port of [18080, 18081]) {
    const probe = createServer();
    await new Promise((accept, reject) =>
      probe.once("error", reject).listen(port, "127.0.0.1", accept),
    );
    await new Promise((accept) => probe.close(accept));
  }
  const runID = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = "keagent_load_" + runID;
  assert.match(databaseName, /^keagent_load_[a-f0-9]{12}$/);
  const output = resolve("output/load-test", runID);
  const goBinary = resolve(
    process.env.LOAD_TEST_GO_BINARY || "output/load-test/cloud.exe",
  );
  await mkdir(output, { recursive: true });
  const maintenanceURL = new URL(originalURL);
  maintenanceURL.pathname = "/postgres";
  const maintenance = new pg.Client({
    connectionString: maintenanceURL.toString(),
  });
  await maintenance.connect();
  const children = [];
  const logs = [];
  const results = [];
  let auth;
  let db;
  let databaseCreated = false;
  const report = {
    runID,
    startedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    environment: {
      variant: process.env.LOAD_TEST_VARIANT || "current-code",
      goBinarySHA256: createHash("sha256")
        .update(await readFile(goBinary))
        .digest("hex"),
      platform: os.platform(),
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCPUs: os.availableParallelism(),
      memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
      node: process.version,
      postgres: "",
      mode: "Next production + Go compiled binary; single-host closed-loop; real AI disabled",
      users: 20,
      propertiesPerUser: 100,
      tasksPerUser: 10,
      resources: 40,
    },
    results,
  };
  const start = async (name, command, args, cwd) => {
    const log = await open(resolve(output, name + ".log"), "w");
    logs.push(log);
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await once(child, "spawn");
    children.push(child);
    return child;
  };
  const request = async (base, path, token, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Origin: "http://127.0.0.1:5174",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: response.status, data };
  };
  const ready = async (base, path) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (children.some((child) => child.exitCode !== null))
        throw new Error("Test service exited; inspect service logs");
      try {
        if ((await request(base, path)).status === 200) return;
      } catch {}
      await new Promise((accept) => setTimeout(accept, 500));
    }
    throw new Error("Test service startup timed out");
  };
  const phase = async (
    name,
    concurrency,
    operation,
    durationMs = 8000,
    maxRequests = 100000,
  ) => {
    const startedAt = new Date().toISOString();
    const before = await db.query(
      "SELECT to_jsonb(d) AS stats FROM pg_stat_database d WHERE datname=$1",
      [databaseName],
    );
    const result = await runPhase({
      name,
      concurrency,
      durationMs,
      operation,
      maxRequests,
    });
    const after = await db.query(
      "SELECT to_jsonb(d) AS stats FROM pg_stat_database d WHERE datname=$1",
      [databaseName],
    );
    result.startedAt = startedAt;
    result.endedAt = new Date().toISOString();
    result.databaseSessionsCreated =
      after.rows[0].stats.sessions - before.rows[0].stats.sessions;
    result.databaseBackends = after.rows[0].stats.numbackends;
    results.push(result);
    console.log(JSON.stringify(result));
    await writeFile(
      resolve(output, "results.json"),
      JSON.stringify(report, null, 2),
    );
    return result;
  };
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    originalURL.pathname = "/" + databaseName;
    Object.assign(process.env, {
      DATABASE_URL: originalURL.toString(),
      NODE_ENV: "production",
      AI_API_KEY: "",
      BETTER_AUTH_URL: authURL,
      JWT_ISSUER: authURL,
      JWT_AUDIENCE: "keagent-api",
      JWKS_URL: authURL + "/api/auth/jwks",
      GO_API_URL: goURL,
      ALLOW_LEGACY_GATEWAY: "true",
    });
    const { getAuth } = await import("../services/control/lib/auth.mjs");
    const { getMigrations } = await import("@app/auth-sdk/migrations");
    auth = getAuth();
    await (await getMigrations(auth.options)).runMigrations();
    const users = [];
    for (let index = 0; index < 20; index++) {
      const email = `load-${index}-${runID}@example.test`;
      const password = crypto.randomUUID();
      const created = await auth.api.createUser({
        body: {
          email,
          password,
          name: "Load " + index,
          role: index === 0 ? "admin" : "user",
        },
      });
      const login = await auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
      });
      assert.equal(login.status, 200);
      const sessionToken = login.headers.get("set-auth-token");
      assert.ok(sessionToken, "Signed SDK Session required");
      const headers = new Headers({ Authorization: "Bearer " + sessionToken });
      const { token } = await auth.api.getToken({ headers });
      users.push({ id: created.user.id, sessionToken, token, email, password });
    }
    await auth.options.database.end();
    auth = undefined;
    const next = await start(
      "auth",
      process.execPath,
      [
        resolve("node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        "18080",
      ],
      resolve("services/control"),
    );
    const go = await start("go", goBinary, [], resolve("services/cloud"));
    await ready(authURL, "/");
    await ready(goURL, "/health");
    report.processes = {
      authPID: next.pid,
      goPID: go.pid,
      driverPID: process.pid,
    };
    console.log(
      "READY " + JSON.stringify({ runID, ...report.processes, output }),
    );
    db = new pg.Client({ connectionString: originalURL.toString() });
    await db.connect();
    report.environment.postgres = (
      await db.query("SELECT version() AS version")
    ).rows[0].version;
    const template = (await request(goURL, "/v1/workspace", users[0].token))
      .data;
    for (const user of users) {
      const workspace = structuredClone(template);
      workspace.properties = Array.from({ length: 100 }, (_, index) => ({
        id: "property-" + index,
        title: "压测房源 " + index,
        community: "测试小区",
        propertyNumber: String(index),
        areaSqm: 90,
        priceCents: 300000000,
        sellingPoints: ["采光", "户型"],
        images: [],
        description: "本机压测专用资料，不调用外部服务。",
      }));
      workspace.tasks = Array.from({ length: 10 }, (_, index) => ({
        id: "task-" + index,
        propertyId: "property-" + index,
        status: "awaiting_review",
        stage: "script",
        script: "压测文案",
        scriptRevision: 1,
        productionRevision: 1,
        progress: 0,
      }));
      await db.query(
        "INSERT INTO keagent_workspace(owner_id,payload) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload",
        [user.id, JSON.stringify(workspace)],
      );
    }
    for (let index = 0; index < 40; index++) {
      await db.query("INSERT INTO keagent_resource(id,payload) VALUES($1,$2)", [
        "resource-" + index,
        JSON.stringify({
          id: "resource-" + index,
          name: "压测资源 " + index,
          type: ["video", "style", "prompt", "cover"][index % 4],
          version: "1",
          published: true,
          publishedOnce: true,
        }),
      ]);
    }
    report.datasetBytes = (
      await db.query(
        "SELECT avg(pg_column_size(payload))::int AS stored, avg(octet_length(payload::text))::int AS json FROM keagent_workspace",
      )
    ).rows[0];
    const read =
      (base, legacy = false) =>
      async (_, iteration) => {
        const user = users[iteration % users.length];
        const result = await request(
          base,
          "/v1/workspace",
          legacy ? user.sessionToken : user.token,
        );
        return {
          status: result.status,
          ok: result.status === 200 && result.data?.properties?.length === 100,
        };
      };
    const mixed = async (_, iteration) => {
      const user = users[iteration % users.length];
      const kind = iteration % 10;
      const path =
        kind < 6
          ? "/v1/workspace"
          : kind < 8
            ? "/v1/session"
            : kind === 8
              ? "/v1/commands/saveDraft"
              : "/v1/commands/updateProfile";
      const body =
        kind === 8
          ? [template.draft]
          : kind === 9
            ? [{ city: "压测城市" }]
            : undefined;
      const result = await request(goURL, path, user.token, body);
      return {
        status: result.status,
        ok: result.status === 200 && result.data !== null,
      };
    };
    await runPhase({
      name: "warmup",
      concurrency: 5,
      durationMs: 3000,
      operation: mixed,
    });
    if (process.argv.includes("--diagnose")) {
      await phase("health-no-database", 20, async () => {
        const result = await request(goURL, "/health");
        return {
          status: result.status,
          ok: result.status === 200 && result.data?.status === "ok",
        };
      });
      const monitor = setInterval(() => {
        void db
          .query(
            "SELECT state,wait_event_type,wait_event,count(*)::int AS connections FROM pg_stat_activity WHERE datname=$1 GROUP BY state,wait_event_type,wait_event",
            [databaseName],
          )
          .then((value) => {
            (report.databaseWaitSamples ||= []).push({
              at: new Date().toISOString(),
              waits: value.rows,
            });
          })
          .catch(() => {});
      }, 500);
      try {
        for (const concurrency of [10, 30, 100])
          await phase("diagnose-mixed", concurrency, mixed);
        await phase("diagnose-recovery", 1, mixed);
      } finally {
        clearInterval(monitor);
      }
      report.completedAt = new Date().toISOString();
      return;
    }
    await phase("direct-read", 1, read(goURL));
    await phase("legacy-read", 1, read(authURL, true));
    await phase("direct-read", 20, read(goURL));
    await phase("legacy-read", 20, read(authURL, true));
    for (const concurrency of [1, 10, 30, 60, 100]) {
      const result = await phase(
        "mixed-60read-20session-20write",
        concurrency,
        mixed,
      );
      if (result.unexpected / result.requests > 0.01) break;
    }
    for (const concurrency of [1, 10, 30]) {
      await phase("same-user-write", concurrency, async () => {
        const result = await request(
          goURL,
          "/v1/commands/updateProperty",
          users[1].token,
          ["property-0", { title: "并发压测房源" }],
        );
        return {
          status: result.status,
          ok: result.status === 200 && result.data?.id === "property-0",
        };
      });
    }
    await phase("admin-read", 20, async (_, iteration) => {
      const paths = ["devices", "resources", "tasks", "audit", "ai-config"];
      const result = await request(
        goURL,
        "/v1/admin/" + paths[iteration % paths.length],
        users[0].token,
      );
      return {
        status: result.status,
        ok: result.status === 200 && result.data !== null,
      };
    });
    const batchConfig = { ...template.draft, propertyIds: ["property-1"] };
    for (const [index, kind] of ["video", "style", "prompt", "cover"].entries())
      batchConfig[kind + "Template"] = {
        id: "resource-" + index,
        version: "1",
      };
    const batchIDs = new Map();
    for (const user of users) {
      const result = await request(
        goURL,
        "/v1/commands/createBatch",
        user.token,
        [batchConfig, "load-idempotency"],
      );
      assert.equal(result.status, 200);
      batchIDs.set(user.id, result.data.id);
    }
    await phase("batch-idempotency", 20, async (_, iteration) => {
      const user = users[iteration % users.length];
      const result = await request(
        goURL,
        "/v1/commands/createBatch",
        user.token,
        [batchConfig, "load-idempotency"],
      );
      return {
        status: result.status,
        ok: result.status === 200 && result.data?.id === batchIDs.get(user.id),
      };
    });
    await phase(
      "script-revision-conflict",
      10,
      async () => {
        const result = await request(
          goURL,
          "/v1/commands/saveScript",
          users[1].token,
          ["task-0", "并发文案", 1],
        );
        return {
          status: result.status,
          ok:
            result.status === 409 ||
            (result.status === 200 && result.data?.scriptRevision === 2),
        };
      },
      8000,
      100,
    );
    await phase(
      "jwt-exchange-rate-limit",
      10,
      async () => {
        const result = await request(
          authURL,
          "/api/auth/token",
          users[2].sessionToken,
        );
        return {
          status: result.status,
          ok: result.status === 200 && typeof result.data?.token === "string",
        };
      },
      8000,
      150,
    );
    await phase(
      "login-rate-limit",
      8,
      async () => {
        const result = await request(
          authURL,
          "/api/auth/sign-in/email",
          undefined,
          { email: users[3].email, password: users[3].password },
        );
        return {
          status: result.status,
          ok: result.status === 200 && !!result.data?.user,
        };
      },
      8000,
      12,
    );
    await phase("recovery-mixed", 1, mixed);
    for (const user of users.slice(1, 4)) {
      assert.equal(
        (await request(goURL, "/v1/admin/devices", user.token)).status,
        403,
      );
    }
    const finalWorkspace = (
      await request(goURL, "/v1/workspace", users[1].token)
    ).data;
    assert.equal(finalWorkspace.properties.length, 100);
    assert.equal(finalWorkspace.tasks.length, 11);
    assert.equal(finalWorkspace.batches.length, 1);
    const plan = await db.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT u.name,u.email,COALESCE(u.role,'user') FROM "session" s JOIN "user" u ON u.id=s."userId" WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND (NOT COALESCE(u.banned,false) OR u."banExpires"<=now())`,
      [
        JSON.parse(Buffer.from(users[0].token.split(".")[1], "base64url")).sid,
        users[0].id,
      ],
    );
    report.identityQueryPlan = plan.rows[0]["QUERY PLAN"];
    report.completedAt = new Date().toISOString();
  } finally {
    await db?.end();
    if (auth) await auth.options.database.end();
    for (const child of children.reverse()) {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
    for (const log of logs) await log.close();
    if (databaseCreated) {
      await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      report.temporaryDatabaseRemoved = true;
    }
    await maintenance.end();
    await writeFile(
      resolve(output, "results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("REPORT " + resolve(output, "results.json"));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
