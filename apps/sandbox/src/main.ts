// 作業場（サンドボックス）の実行役のエントリ（Docker。D-116）。
// 環境変数：SANDBOX_TOKEN（この作業場だけのトークン）・SANDBOX_EDGE_URL（app の URL）・SANDBOX_ROOT（既定 /workspace）・
// SANDBOX_RUN_AS_UID / SANDBOX_RUN_AS_GID（コマンドを動かす利用者。既定 10001）。
// トークンは読んだらすぐ環境変数から消す（コマンドは権限のない利用者で動き、この プロセスの環境変数は読めない）

import { httpTransport, runExecutor } from "@open-team/sandbox";

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ severity: "INFO", event, ...fields })}\n`);
}

async function main(): Promise<number> {
  const token = process.env.SANDBOX_TOKEN ?? "";
  delete process.env.SANDBOX_TOKEN;
  const edgeUrl = process.env.SANDBOX_EDGE_URL ?? "";
  if (token === "" || edgeUrl === "") {
    log("sandbox.misconfigured", { hasToken: token !== "", hasEdgeUrl: edgeUrl !== "" });
    return 2;
  }
  const root = process.env.SANDBOX_ROOT ?? "/workspace";
  const uid = Number(process.env.SANDBOX_RUN_AS_UID ?? "10001");
  const gid = Number(process.env.SANDBOX_RUN_AS_GID ?? String(uid));
  // root のときだけ権限のない利用者に落とす（手元で root でなく動かすときはそのまま）
  const runAs = process.getuid?.() === 0 && Number.isInteger(uid) && uid > 0 ? { uid, gid } : undefined;
  const out = await runExecutor({
    transport: httpTransport({ baseUrl: edgeUrl, token }),
    root,
    ...(runAs === undefined ? {} : { runAs }),
    log: (event, fields) => log(event, fields),
  });
  log("sandbox.finished", out);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stdout.write(`${JSON.stringify({ severity: "ERROR", event: "sandbox.crashed", message: e instanceof Error ? e.message : String(e) })}\n`);
    process.exit(1);
  },
);
