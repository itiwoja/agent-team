// デプロイ後のスモークテスト（本番の URL に、審査員と同じ入口から入って、用意した依頼の流れを通す）。Node だけ（依存なし）。
// 環境変数：
//   BASE_URL           必須。app の URL（例 https://app-<番号>.asia-northeast1.run.app）
//   GITHUB_SHA         必須。デプロイしたコミット。/api/health の commit がこれになるまで待つ
//   GUEST_ENTRY_TOKEN  必須。審査員用の入口のトークン（画面・ログに出さない）
//   SMOKE_RETEST       1 のとき、締める提案を適用して再試験し、合格証が出るところまで確かめる（台本での再現なので Gemini の費用は 0）
// 手順：health → 入口 → セッション → 依頼（担当2人）→ リハーサルの結果（12件・すり抜け2件）→（再試験 → 合格証）→ ログアウト（後片付け）
// 1つでも期待と違えば終了コード 1。後片付け（ログアウト）の失敗だけは警告にとどめる。

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const SHA = process.env.GITHUB_SHA ?? "";
const TOKEN = process.env.GUEST_ENTRY_TOKEN ?? "";
const RETEST = process.env.SMOKE_RETEST === "1";
const HEALTH_WAIT_MS = 120_000;
const RETEST_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`== ${msg}`);
const ok = (msg) => console.log(`ok: ${msg}`);

class SmokeError extends Error {}
function fail(msg) {
  throw new SmokeError(msg);
}
function expect(cond, msg) {
  if (!cond) fail(msg);
}

if (!/^https?:\/\//.test(BASE_URL)) {
  console.error("::error::BASE_URL がない");
  process.exit(1);
}
if (!SHA) {
  console.error("::error::GITHUB_SHA がない");
  process.exit(1);
}
if (!TOKEN) {
  console.error("::error::GUEST_ENTRY_TOKEN がない");
  process.exit(1);
}
// トークンはログに出さない（マスクは呼び出し側の deploy.yml が ::add-mask:: でかける。このスクリプトは値を出力しない）

let cookie = "";
let csrf = "";

/** 1回の要求。Cookie と CSRF と Origin を付ける。本文のエラーは出さない（トークン・Cookie を含みうる要求は出さない） */
async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers.origin = new URL(BASE_URL).origin;
    if (csrf) headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, setCookie };
}

function errText(r) {
  const code = r.json?.error?.code ?? r.json?.code ?? "";
  return `HTTP ${r.status}${code ? ` ${code}` : ""}`;
}

// ---- 1. デプロイした版になるまで待つ ----
async function waitForCommit() {
  step(`/api/health の commit が ${SHA.slice(0, 7)} になるまで（最大 ${HEALTH_WAIT_MS / 1000} 秒）`);
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let last = "応答なし";
  while (Date.now() < deadline) {
    try {
      const r = await api("GET", "/api/health");
      if (r.status === 200 && r.json?.status === "ok") {
        last = `commit=${String(r.json.commit).slice(0, 7)}`;
        if (r.json.commit === SHA) {
          ok(`health（${last}）`);
          return;
        }
      } else {
        last = errText(r);
      }
    } catch (e) {
      last = `接続できない（${e?.name ?? "error"}）`;
    }
    await sleep(5000);
  }
  fail(`/api/health が ${SHA} にならない（最後：${last}）`);
}

// ---- 2〜3. 入口・セッション ----
async function enter() {
  step("入口（POST /api/v1/entry）");
  const r = await api("POST", "/api/v1/entry", { token: TOKEN });
  expect(r.status === 200, `入口が通らない（${errText(r)}）`);
  expect(r.json?.state === "signed_in" && r.json?.workspaceKind === "guest", "入口の応答がゲストのセッションではない");
  const sid = r.setCookie.map((c) => c.split(";")[0]).filter(Boolean);
  expect(sid.length > 0, "Cookie が返らない");
  cookie = sid.join("; ");
  ok("ゲストとして入った");

  step("セッション（GET /api/v1/session）");
  const s = await api("GET", "/api/v1/session");
  expect(s.status === 200 && s.json?.state === "signed_in", `セッションが取れない（${errText(s)}）`);
  expect(typeof s.json.csrfToken === "string" && s.json.csrfToken.length > 0, "csrfToken がない");
  expect(typeof s.json.firstAskId === "string", "firstAskId がない");
  csrf = s.json.csrfToken;
  ok("csrfToken・firstAskId");
  const me = await api("GET", "/api/v1/me");
  expect(me.status === 200 && typeof me.json?.workspace?.id === "string", `ワークスペースの ID が取れない（${errText(me)}）`);
  return { askId: s.json.firstAskId, workspaceId: me.json.workspace.id };
}

// ---- 4. 用意した依頼とリハーサルの結果 ----
async function checkPrepared({ askId, workspaceId }) {
  step("用意した依頼（担当2人）");
  const a = await api("GET", `/api/v1/asks/${askId}`);
  expect(a.status === 200, `依頼が取れない（${errText(a)}）`);
  const workers = (a.json?.stages ?? []).filter((x) => !x.isAggregator);
  expect(workers.length === 2, `担当が2人ではない（${workers.length}人）`);
  ok(`担当 ${workers.map((w) => w.agentName).join("・")}`);

  step("リハーサルの結果（試験12件・すり抜け2件）");
  const list = await api("GET", `/api/v1/workspaces/${workspaceId}/rehearsals?askId=${askId}`);
  expect(list.status === 200 && Array.isArray(list.json?.items) && list.json.items.length > 0, `リハーサルの走行がない（${errText(list)}）`);
  const run = list.json.items[0];
  const res = await api("GET", `/api/v1/workspaces/${workspaceId}/rehearsals/${run.id}/result`);
  expect(res.status === 200, `結果が取れない（${errText(res)}）`);
  const total = res.json?.counts?.total;
  const slipped = res.json?.counts?.withControl?.slipped;
  expect(total === 12, `試験が12件ではない（${total}）`);
  expect(slipped === 2, `すり抜けが2件ではない（${slipped}）`);
  ok(`試験 ${total} 件・すり抜け ${slipped} 件`);
  return { runId: run.id, proposals: res.json.proposals ?? [] };
}

// ---- 5. 締める提案 → 再試験 → 合格証 ----
async function retest({ workspaceId }, { runId, proposals }) {
  step("締める提案を適用して再試験（SMOKE_RETEST=1）");
  expect(proposals.length > 0, "締める提案がない");
  // 上から順に、まだ塞がれていない状況を塞ぐものだけ
  const covered = new Set();
  const chosen = [];
  for (const p of proposals) {
    const fresh = (p.fixes ?? []).filter((f) => !covered.has(f));
    if (fresh.length === 0) continue;
    fresh.forEach((f) => covered.add(f));
    chosen.push(p);
  }
  expect(chosen.length > 0, "適用する提案がない");
  let retestRunId = null;
  for (const [i, p] of chosen.entries()) {
    const last = i === chosen.length - 1;
    const r = await api("POST", `/api/v1/workspaces/${workspaceId}/rehearsals/${runId}/tightening`, last ? { proposalId: p.id } : { proposalId: p.id, retest: false });
    if (last) {
      expect(r.status === 202 && r.json?.run?.id, `再試験が始まらない（${errText(r)}${r.json?.retestError ? ` ${r.json.retestError.code}` : ""}）`);
      retestRunId = r.json.run.id;
    } else {
      expect(r.status === 200, `提案の適用に失敗（${i + 1}/${chosen.length}、${errText(r)}）`);
    }
  }
  ok(`提案 ${chosen.length} 件を適用、再試験を開始`);

  const deadline = Date.now() + RETEST_WAIT_MS;
  let view = null;
  while (Date.now() < deadline) {
    const r = await api("GET", `/api/v1/workspaces/${workspaceId}/rehearsals/${retestRunId}`);
    expect(r.status === 200, `再試験の進捗が取れない（${errText(r)}）`);
    view = r.json.run;
    if (view.status === "done" || view.status === "failed" || view.status === "cancelled") break;
    await sleep(3000);
  }
  expect(view && view.status === "done", `再試験が ${RETEST_WAIT_MS / 1000} 秒以内に終わらない（status=${view?.status ?? "不明"}${view?.error ? "、error あり" : ""}）`);
  expect(typeof view.certificateId === "string" && view.certificateId, `合格証が出ていない（reason=${view.certificateReason ?? "なし"}）`);
  const cert = await api("GET", `/api/v1/workspaces/${workspaceId}/rehearsals/${retestRunId}/certificate`);
  expect(cert.status === 200, `合格証が取れない（${errText(cert)}）`);
  ok("再試験が終わり、合格証が出た");
}

// ---- 6. 後片付け（失敗は警告のみ） ----
async function cleanup() {
  step("後片付け（POST /api/v1/logout）");
  try {
    const r = await api("POST", "/api/v1/logout");
    if (r.status === 204) ok("ログアウトした");
    else console.log(`::warning::ログアウトできなかった（${errText(r)}）。ゲストのワークスペースは 7 日後に掃除される`);
  } catch (e) {
    console.log(`::warning::ログアウトできなかった（${e?.name ?? "error"}）`);
  }
}

let failed = false;
try {
  await waitForCommit();
  const ctx = await enter();
  try {
    const prepared = await checkPrepared(ctx);
    if (RETEST) await retest(ctx, prepared);
    else console.log("skip: 再試験（SMOKE_RETEST が 1 ではない）");
  } finally {
    await cleanup();
  }
} catch (e) {
  failed = true;
  console.error(`::error::スモークテストが落ちた：${e instanceof SmokeError ? e.message : `${e?.name ?? "Error"}: ${e?.message ?? e}`}`);
}
if (failed) process.exit(1);
console.log("スモークテスト：すべて通った");
