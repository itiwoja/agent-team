// 汚染（taint）の状態の遷移と、表示の固定の文（MT §3.9・§3.15・§3.16、BR-38・51・70・71・75・76）
// 純粋関数：遷移を決めるだけで保存は edge（「Kernel が記録」＝ ADR-024）。tainted を false に戻す関数は作らない（解除できない：BR-38）
// 汚染は decide() の結果を変えない（BR-39）。効くのは表示（送る前の確認・回答・受け渡しの印）と設定の変更（BR-51）と、
// 作業場のコマンドをどの操作として判定するか（SG-07：taintedByOutsideContent → operationOfCommand。decide の外で決める）だけ
// 表示の文に入れるのは信用できる値だけ：コネクタの表示名・エージェント名・URL のホスト（MT D-26）。読んだ中身（差出人名など）は入れない

import type { DirectTaintSource, IsoDateTime, TaintSource, TaintState, Uuid } from "./types.ts";

/** sources の上限（MT §2.1 taintSourcesMax）。古い順に残す（最初に読んだものが表示の主になる） */
export const TAINT_SOURCES_MAX = 50;

/**
 * 重複の鍵（MT §3.9-1）：mcp_read は (connectorId, tool)、web_fetch は url、web_search は1件、handoff は fromTaskId、team_message は messageId。
 * SG-05：skill は名前、workspace_snapshot は控えを残したタスク（fromTaskId）
 */
function sourceKey(src: TaintSource): string {
  switch (src.kind) {
    case "mcp_read":
      return JSON.stringify(["mcp_read", src.connectorId, src.tool]);
    case "web_search":
      return JSON.stringify(["web_search"]);
    case "web_fetch":
      return JSON.stringify(["web_fetch", src.url]);
    case "sandbox_run":
      return JSON.stringify(["sandbox_run"]);
    case "skill":
      return JSON.stringify(["skill", src.name]);
    case "handoff":
      return JSON.stringify(["handoff", src.fromTaskId]);
    case "team_message":
      return JSON.stringify(["team_message", src.messageId]);
    case "workspace_snapshot":
      return JSON.stringify(["workspace_snapshot", src.fromTaskId]);
    default:
      // DB の jsonb などから知らない種類が来ても落とさない（中身ごと鍵にする）
      return JSON.stringify(["unknown", src]);
  }
}

/** 重複を除き（最初のものを残す）、先頭から TAINT_SOURCES_MAX 件まで */
function dedupeCap<T extends TaintSource>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of list) {
    const key = sourceKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= TAINT_SOURCES_MAX) break;
  }
  return out;
}

/** 汚染されているか。tainted と sources が食い違っていたら汚染として扱う（厳しい側） */
export function isTainted(state: TaintState): boolean {
  return state.tainted === true || (Array.isArray(state.sources) && state.sources.length > 0);
}

/**
 * 外の内容を読んだか（SG-07 の (a)。作業場のコマンドを run_shell にするかの入力：operations.ts の operationOfCommand）。
 * 作業場で自分が動かしたコマンドの出力（sandbox_run）だけの汚染は数えない：数えると最初の run_command のあと
 * どのテストも動かせなくなる（作る→動かす→直すの繰り返しができない）。作業場の中のコードは担当が書いたもので、
 * 入れたパッケージのコードはインストールのときにもう動いている。境界は網（フェーズ1）。
 * 数え方（true＝外の内容）：
 * - 汚染なし → false
 * - sandbox_run → 数えない
 * - 受け渡し（handoff）・連絡（team_message）・作業場の控え（workspace_snapshot：SG-05）→ upstream が sandbox_run だけなら数えない。
 *   upstream に外の内容（Web・コネクタ・検索・スキルなど）があれば数える。upstream が空・壊れている・上限（TAINT_SOURCES_MAX）に達して
 *   切られたかもしれないときは数える（控えの鎖で、前のタスクが読んだ Web の内容が次のタスクに洗い流されないように）
 * - mcp_read・web_search・web_fetch・skill・知らない種類 → 数える
 * - 食い違い（tainted なのに sources が空・配列でない）→ 数える
 * - sources が上限（TAINT_SOURCES_MAX）に達している → 数える（新しい出どころが捨てられたかもしれない。厳しい側）
 */
export function taintedByOutsideContent(state: TaintState): boolean {
  if (!isTainted(state)) return false;
  const sources: readonly TaintSource[] = Array.isArray(state.sources) ? state.sources : [];
  if (sources.length === 0 || sources.length >= TAINT_SOURCES_MAX) return true;
  return sources.some((s) => {
    if (s === null || typeof s !== "object") return true;
    if (s.kind === "sandbox_run") return false;
    if (s.kind === "handoff" || s.kind === "team_message" || s.kind === "workspace_snapshot") {
      const up: readonly DirectTaintSource[] = Array.isArray(s.upstream) ? s.upstream : [];
      if (up.length === 0 || up.length >= TAINT_SOURCES_MAX) return true;
      return up.some((u) => u === null || typeof u !== "object" || u.kind !== "sandbox_run");
    }
    return true; // mcp_read・web_search・web_fetch・skill・知らない種類
  });
}

/**
 * 外部の内容を受け取ったときの遷移（MT §3.9 addTaintSource、BR-38）。
 * 重複を除いて末尾に足し、50件まで（古い順に残す）。結果は必ず tainted: true（単調。戻す関数はない）
 */
export function addTaintSource(state: TaintState, src: TaintSource): TaintState {
  return { tainted: true, sources: dedupeCap([...state.sources, src]) };
}

/** 他のタスクの汚染を upstream に持つ出どころ（受け渡し・連絡・作業場の控え） */
function hasUpstream(s: TaintSource): s is Extract<TaintSource, { upstream: DirectTaintSource[] }> {
  return s.kind === "handoff" || s.kind === "team_message" || s.kind === "workspace_snapshot";
}

/**
 * 直接読んだものを平らにする（MT §3.9 flattenDirectSources）。handoff・team_message・workspace_snapshot は upstream を展開する。
 * 重複を除き 50件まで（順番の段が重なっても upstream が膨らまないように。MT D-25 の上限を upstream にも当てた）
 */
export function flattenDirectSources(state: TaintState): DirectTaintSource[] {
  const out: DirectTaintSource[] = [];
  for (const s of state.sources) {
    if (hasUpstream(s)) {
      if (Array.isArray(s.upstream)) out.push(...s.upstream);
    } else {
      out.push(s);
    }
  }
  return dedupeCap(out);
}

/**
 * 受け渡しで始まるタスクの汚染（MT §3.9 taintFromInputs、BR-71。順番の次の段・まとめ役）。
 * どれも汚染されていなければ汚染なし。汚染された入力ごとに handoff を1件（upstream は平らにしたもの）。タスクはこの状態で始まる
 */
export function taintFromInputs(
  inputs: readonly { taskId: Uuid; agentName: string; taint: TaintState }[],
  now: IsoDateTime,
): TaintState {
  const sources: TaintSource[] = [];
  for (const input of inputs) {
    if (!isTainted(input.taint)) continue;
    sources.push({
      kind: "handoff",
      fromTaskId: input.taskId,
      fromAgentName: input.agentName,
      upstream: flattenDirectSources(input.taint),
      at: now,
    });
  }
  return sources.length === 0 ? { tainted: false, sources: [] } : { tainted: true, sources: dedupeCap(sources) };
}

/**
 * 連絡板の連絡を差し込んだ時点の遷移（MT §3.9 taintOnTeamMessage、BR-75。Should）。
 * msg.tainted は送った時点の送り手の値（ask_messages.tainted）。汚染されていない連絡では状態を変えない（同じ値を返す）。
 * 追いのターンは親のタスクの汚染から始め、質問の連絡をこれで足す（MT §3.9・FR §8-23）
 */
export function taintOnTeamMessage(
  state: TaintState,
  msg: { messageId: Uuid; fromTaskId: Uuid; fromAgentName: string; tainted: boolean; upstream: readonly DirectTaintSource[] },
  now: IsoDateTime,
): TaintState {
  if (msg.tainted !== true) return state;
  return addTaintSource(state, {
    kind: "team_message",
    messageId: msg.messageId,
    fromTaskId: msg.fromTaskId,
    fromAgentName: msg.fromAgentName,
    upstream: dedupeCap(msg.upstream),
    at: now,
  });
}

/**
 * 作業場の控えを受け取った時点の遷移（SG-05）。控えを残したタスクが汚染されていれば、受け取ったタスクも汚染する
 * （taintFromInputs の受け渡しと同じ扱い：upstream は控えの汚染を平らにしたもの）。
 * 控えが汚染されていない（パックが置いた控え・汚染されていないタスクの控え）・自分の控えなら状態を変えない（同じ値を返す）
 */
export function taintOnWorkspaceSnapshot(
  state: TaintState,
  snap: { snapshotId: Uuid; fromTaskId: Uuid | null; taint: TaintState },
  receiverTaskId: Uuid,
  now: IsoDateTime,
): TaintState {
  if (!isTainted(snap.taint)) return state;
  // 自分が残した控え：その汚染はもうタスクに付いている（汚染は戻らない）
  if (snap.fromTaskId === receiverTaskId) return state;
  return addTaintSource(state, {
    kind: "workspace_snapshot",
    snapshotId: snap.snapshotId,
    // 控えを残したタスクが分からない汚染された控えは、控えの ID を元として扱う（鍵が重ならないように）
    fromTaskId: snap.fromTaskId ?? snap.snapshotId,
    upstream: flattenDirectSources(snap.taint),
    at: now,
  });
}

// ここから表示（MT §3.15。文はすべて固定の文で作り、LLM に書かせない：ask-and-check.md:135）

/** URL のホスト。解釈できなければ null */
function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** 直接読んだもののラベル：mcp_read はコネクタの表示名、web_fetch は URL のホスト、web_search は「Web 検索」 */
function directLabel(s: DirectTaintSource): string {
  switch (s.kind) {
    case "mcp_read": {
      const name = typeof s.connectorName === "string" ? s.connectorName.trim() : "";
      return name !== "" ? name : s.connectorSlug;
    }
    case "web_search":
      return "Web 検索";
    case "web_fetch":
      return hostOf(s.url) ?? "Web ページ";
    case "sandbox_run":
      return "作業場で動かしたコマンドの出力";
    case "skill":
      // 名前は DB の値なので入れない（MT D-26）
      return "運営のパックで確かめられないスキル";
    default:
      return "外部の内容";
  }
}

function upstreamOf(s: TaintSource): readonly DirectTaintSource[] {
  return hasUpstream(s) && Array.isArray(s.upstream) ? s.upstream : [];
}

/** 受け渡し・連絡のラベル（「受信箱係が読んだメール」「受信箱係からの連絡」） */
function sourceLabel(s: TaintSource): string {
  if (s.kind === "handoff") {
    const first = upstreamOf(s)[0];
    return `${s.fromAgentName}が読んだ${first === undefined ? "内容" : directLabel(first)}`;
  }
  if (s.kind === "team_message") return `${s.fromAgentName}からの連絡`;
  if (s.kind === "workspace_snapshot") {
    const first = upstreamOf(s)[0];
    return `前の作業で残ったファイル（${first === undefined ? "外部の内容" : directLabel(first)}）`;
  }
  return directLabel(s);
}

function sourceDetail(s: TaintSource): string {
  switch (s.kind) {
    case "mcp_read":
      return `${s.connectorSlug}.${s.tool}`;
    case "web_search":
      return "web_search";
    case "web_fetch":
      return s.url;
    case "sandbox_run":
      return "run_command";
    case "skill":
      return "load_skill";
    default:
      return upstreamOf(s).map(directLabel).join("、");
  }
}

export interface TaintSourceItem {
  kind: TaintSource["kind"];
  /** 例「メール」「example.com」「Web 検索」「受信箱係が読んだメール」「受信箱係からの連絡」 */
  label: string;
  /** 例「mail.list_inbox」・URL・受け渡しの元が読んだもののラベル（「、」区切り） */
  detail: string;
}

/** 送る前の確認の「汚染」区画の一覧（MT §3.15、intents.md:129、BR-41）。汚染されていなければ空 */
export function taintSourceList(snapshot: TaintState): TaintSourceItem[] {
  if (!isTainted(snapshot)) return [];
  return dedupeCap(snapshot.sources).map((s) => ({ kind: s.kind, label: sourceLabel(s), detail: sourceDetail(s) }));
}

/** 文の主にする情報源：連絡（BR-76）→ 受け渡し（BR-71）→ 最初の情報源 の順。others は残りの件数 */
function primarySource(snapshot: TaintState): { source: TaintSource | null; others: number } {
  const sources = dedupeCap(snapshot.sources);
  const source =
    sources.find((s) => s.kind === "team_message") ?? sources.find((s) => s.kind === "handoff") ?? sources[0] ?? null;
  return { source, others: Math.max(0, sources.length - 1) };
}

/**
 * BR-70 の汚染の1行（MT §3.15 taintReasonLine。送る前の確認の宛先の下に出す）。汚染されていなければ null。
 * 連絡「{担当}からの連絡のあとの送信です」（BR-76）／受け渡し「{担当}が読んだ{ラベル}のあとの送信です」／
 * それ以外「外から読んだ内容（{ラベル}）のあとの送信です」（BR-70）。情報源が2つ以上なら末尾に「（ほか{N}件）」
 */
export function taintReasonLine(snapshot: TaintState): string | null {
  if (!isTainted(snapshot)) return null;
  const { source, others } = primarySource(snapshot);
  let line: string;
  if (source === null) line = "外から読んだ内容のあとの送信です";
  else if (source.kind === "team_message") line = `${source.fromAgentName}からの連絡のあとの送信です`;
  else if (source.kind === "handoff" || source.kind === "workspace_snapshot") line = `${sourceLabel(source)}のあとの送信です`;
  else line = `外から読んだ内容（${directLabel(source)}）のあとの送信です`;
  return others > 0 ? `${line}（ほか${others}件）` : line;
}

/**
 * 回答の汚染の1行（MT §3.15 answerTaintLine、FR-063：agents.md:274）。回答を書いたタスクが汚染されていなければ null。
 * 「外部の内容をもとにしています（受信箱係が読んだメール）」。情報源が2つ以上なら「（…、ほか{N}件）」
 */
export function answerTaintLine(answerTask: TaintState): string | null {
  if (!isTainted(answerTask)) return null;
  const { source, others } = primarySource(answerTask);
  if (source === null) return "外部の内容をもとにしています";
  return `外部の内容をもとにしています（${sourceLabel(source)}${others > 0 ? `、ほか${others}件` : ""}）`;
}

/** SCR-021 の段の間の「渡したもの」に添える印（MT §3.15 handoffMark、ask-page.md:114。色だけに頼らず文字で出す） */
export function handoffMark(fromTask: TaintState): "外部の内容を含む" | null {
  return isTainted(fromTask) ? "外部の内容を含む" : null;
}

/**
 * 設定の変更案を確認カードにするか（MT §3.16、BR-47・BR-51。classify() の外の判定：KC §3）。
 * byUserDirectAction = true（出さない）にするのは、押したこと自体がその変更の承認になる操作だけ：
 * 確認カードの承認・[以後も許可]（BR-47 ①）・リハーサルの [適用]（narrow だけ）・ルールの [取り消す]。
 * 詳細設定での直接の編集は false で渡す（D-13：設定変更として保存し、classify が widen なら確認カード。MT §3.16-1 より D-13 を正とした）。
 * widen は出す（BR-47）。きっかけのタスク（agent_config_changes.source_task_id）が汚染されていれば neutral・narrow でも出す（BR-51）
 */
export function requiresConfirmationCard(change: {
  classification: "narrow" | "neutral" | "widen";
  sourceTaskTainted: boolean;
  byUserDirectAction: boolean;
}): boolean {
  if (change.byUserDirectAction === true) return false;
  // widen と、知らない分類は確認カード（厳しい側）
  if (change.classification !== "narrow" && change.classification !== "neutral") return true;
  return change.sourceTaskTainted === true;
}
