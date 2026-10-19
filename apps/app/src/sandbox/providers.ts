// 作業場（サンドボックス）の起こし方（D-116）。edge の SandboxProvider の実装。
// - cloudrun：Cloud Run Jobs の実行を1つ起こす（jobs.run の overrides でトークンを渡す）。権限ゼロの SA・通信の制限はジョブの側の設定（infra/sandbox-setup.sh）
// - docker：手元の Docker でコンテナを1つ起こす（docker compose で試すとき）
// - inprocess：app と同じプロセスで作業場の実行役を動かす（隔離なし。local と試験だけ：env が cloud で拒む）
// どれも「起こすだけ」で待たない。実行役は sandbox-edge（/sandbox/v1）にトークンで来る

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxEdge, SandboxProvider } from "@open-team/edge";
import type { Logger } from "@open-team/platform";
import { runExecutor, type SandboxTransport } from "@open-team/sandbox";
import type { SandboxEnv } from "../env.ts";

/** Cloud Run のメタデータサーバーからアクセストークンを取る（app の SA：run.jobs.runWithOverrides が要る） */
async function metadataAccessToken(fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`メタデータサーバーのトークンを取れない（${res.status}）`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("メタデータサーバーの応答にトークンがない");
  return body.access_token;
}

export function cloudRunJobsProvider(o: { job: string; edgeUrl: string; fetch?: typeof fetch; log: Logger }): SandboxProvider {
  const f = o.fetch ?? fetch;
  return {
    name: "cloudrun",
    async start({ sessionId, taskId, token }) {
      const access = await metadataAccessToken(f);
      const res = await f(`https://run.googleapis.com/v2/${o.job}:run`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                env: [
                  { name: "SANDBOX_TOKEN", value: token },
                  { name: "SANDBOX_EDGE_URL", value: o.edgeUrl },
                  { name: "SANDBOX_SESSION_ID", value: sessionId },
                  { name: "SANDBOX_TASK_ID", value: taskId },
                ],
              },
            ],
            taskCount: 1,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Cloud Run Jobs の実行を起こせない（${res.status}）`);
      const op = (await res.json()) as { name?: unknown; metadata?: { name?: unknown } };
      const ref = typeof op.metadata?.name === "string" ? op.metadata.name : typeof op.name === "string" ? op.name : "cloudrun";
      o.log.info("sandbox.started", "作業場（Cloud Run Jobs）を起こした", { sessionId, taskId, ref });
      return { ref };
    },
  };
}

export function dockerProvider(o: { image: string; edgeUrl: string; network?: string; log: Logger }): SandboxProvider {
  return {
    name: "docker",
    start({ sessionId, taskId, token }) {
      const args = ["run", "-d", "--rm", "--memory", "1g", "--cpus", "1", "--pids-limit", "256"];
      if (o.network !== undefined) args.push("--network", o.network);
      // トークンは引数に書かず、環境変数で渡す（ps に出さない）
      args.push("-e", "SANDBOX_TOKEN", "-e", `SANDBOX_EDGE_URL=${o.edgeUrl}`, "-e", `SANDBOX_SESSION_ID=${sessionId}`, "-e", `SANDBOX_TASK_ID=${taskId}`, o.image);
      return new Promise((resolve, reject) => {
        const child = spawn("docker", args, { env: { ...process.env, SANDBOX_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (b: Buffer) => (out += b.toString()));
        child.stderr.on("data", (b: Buffer) => (err += b.toString()));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`docker run が失敗（${code}）：${err.slice(0, 300)}`));
          const ref = out.trim().slice(0, 64);
          o.log.info("sandbox.started", "作業場（Docker）を起こした", { sessionId, taskId, ref });
          resolve({ ref });
        });
      });
    },
  };
}

/** 同じプロセスで実行役を動かす（隔離なし。local と試験だけ）。runs は試験が終わりを待つため */
export function inProcessProvider(o: { edge: () => SandboxEdge; log: Logger; sleep?: (ms: number) => Promise<void>; nextWaitSec?: number }): SandboxProvider & { runs: Set<Promise<unknown>> } {
  const runs = new Set<Promise<unknown>>();
  return {
    name: "inprocess",
    runs,
    async start({ sessionId, taskId, token }) {
      const root = await mkdtemp(path.join(tmpdir(), "open-team-sandbox-"));
      const edge = o.edge();
      const transport: SandboxTransport = {
        claim: () => edge.claim(token),
        next: (w) => edge.next(token, o.nextWaitSec ?? w),
        result: async (id, r) => void (await edge.result(token, id, r)),
        archive: (a, meta) => edge.archive(token, a, meta),
      };
      const p: Promise<unknown> = runExecutor({ transport, root, ...(o.sleep === undefined ? {} : { sleep: o.sleep }) })
        .catch((error) => o.log.warn("sandbox.inprocess_failed", "同じプロセスの作業場が止まった", { sessionId, taskId, error }))
        .finally(() => {
          runs.delete(p);
          void rm(root, { recursive: true, force: true });
        });
      runs.add(p);
      return { ref: root };
    },
  };
}

/** 環境変数から作業場の起こし方を決める。none なら null（作業場の道具は渡さない） */
export function createSandboxProvider(env: SandboxEnv, o: { edge: () => SandboxEdge; log: Logger; fetch?: typeof fetch }): SandboxProvider | null {
  switch (env.provider) {
    case "cloudrun":
      return env.job !== undefined && env.edgeUrl !== undefined ? cloudRunJobsProvider({ job: env.job, edgeUrl: env.edgeUrl, log: o.log, ...(o.fetch === undefined ? {} : { fetch: o.fetch }) }) : null;
    case "docker":
      return env.dockerImage !== undefined && env.edgeUrl !== undefined
        ? dockerProvider({ image: env.dockerImage, edgeUrl: env.edgeUrl, log: o.log, ...(env.dockerNetwork === undefined ? {} : { network: env.dockerNetwork }) })
        : null;
    case "inprocess":
      return inProcessProvider({ edge: o.edge, log: o.log });
    case "none":
      return null;
  }
}
