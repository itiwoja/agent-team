// SCR-021 の安全チェックの区画：最上部の3行・防いだ損害・件数・権限を絞る提案［適用］・状況の行・「こんな日も試す」・もう一度、全部試す
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, describeError, type AskRehearsalView, type DamageBreakdownView, type IncidentNote, type IncidentNoteItem, type RehearsalCase, type RehearsalCertificate, type RehearsalCounts, type RehearsalRun, type RehearsalResult, type TighteningProposal, type UserCaseResult } from "../api";
import { formatUsd, formatYen } from "../lib/format";
import {
  askScenarioRows,
  certificateLabel,
  certificateTone,
  elapsedParts,
  faultIdsText,
  fromEvent,
  fromResultRow,
  generatedCount,
  generatingParts,
  generatorText,
  interpretationText,
  isScriptedRun,
  mergeRetestRows,
  pickAskRuns,
  pickPreviousRun,
  plainPhaseLine,
  plainSummaryLines,
  REAL_RUN_NOTE,
  rerunNote,
  retestProgress,
  SCRIPTED_MARK,
  SCRIPTED_NOTE,
  scenarioLine,
  upsertScenario,
  USER_CASE_NOTE,
  USER_CASE_UNMATCHED,
  userCasePlaceholder,
  actionErrorText,
  type ScenarioVM,
} from "../lib/rehearsal";
import { firstBatchNote } from "../lib/firstBatch";
import { Link } from "../lib/router";
import { useElapsedSeconds } from "../lib/useElapsed";
import { useWorkspace, useWorkspaceEvent } from "../workspace";
import { Glossary, WithTerm } from "./Glossary";
import { RestartSheet } from "./RestartSheet";
import { Chevron } from "../ui/icons";
import { selectAttributionRuns } from "../../../app/src/rehearsal/attribution";
import "../styles/rehearsal.css";

const ACTIVE = new Set(["queued", "generating", "running"]);
/** 合格証が切れている間、自動の再リハーサル（毎分の tick が始める。始まりの事象はない）を拾うための見直しの間隔と回数 */
const RECERTIFY_POLL_MS = 10_000;
const RECERTIFY_POLL_MAX = 60;

/** 再試験が走っている間だけ持つ、1つ前の走行の結果（行を薄く残して1件ずつ置き換える：F-088） */
interface PreviousRun {
  rows: ScenarioVM[];
  prevented: number;
  counts: RehearsalCounts | null;
}

interface State {
  primary: RehearsalRun;
  /** 担当の仕事の自動の再リハーサル（依頼の走行より後。仕事ごとに新しい1件） */
  recertify: RehearsalRun[];
  result: RehearsalResult;
  rows: ScenarioVM[];
  certificate: RehearsalCertificate | null;
  cases: Map<string, RehearsalCase>;
  runIds: Set<string>;
  active: boolean;
  previous: PreviousRun | null;
}

export function RehearsalSection({ askId, summary }: { askId: string; summary: AskRehearsalView | null }) {
  const { workspace, killSwitchEngaged, online } = useWorkspace();
  const wsId = workspace.id;
  const [state, setState] = useState<State | null>(null);
  const [none, setNone] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // [リハーサルする] を押した時刻。走行ができる（Gemini が悪い日を作り終える）まで、画面はまだ走行を知らないのでこれで待ちを出す
  const [startingAt, setStartingAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 要求番号。load() が並行に走ったとき、古い応答で新しい応答を上書きしない
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const fresh = (): boolean => mine === seq.current;
    try {
      const { items } = await api.rehearsals(wsId, askId);
      const selected = selectAttributionRuns(items.map((r) => ({ ...r, ask_id: r.askId, job_id: r.jobId, created_at: r.createdAt })), askId);
      const byId = new Map(items.map((r) => [r.id, r]));
      const primary = selected.primary === null ? null : byId.get(selected.primary.id) ?? null;
      const recertify = selected.recertify.map((r) => byId.get(r.id)!).filter(Boolean);
      if (!primary) {
        if (!fresh()) return;
        setNone(true);
        setState(null);
        return;
      }
      const jobIds = [...new Set(recertify.map((r) => r.jobId).filter((j): j is string => j !== null))];
      // 再試験が走っている間は、1つ前の走行の結果も取って行を薄く残す
      const previousRun = selected.previous === null ? null : byId.get(selected.previous.id) ?? null;
      const [result, certificate, cases, recertResults, jobCases, previousResult] = await Promise.all([
        api.rehearsalResult(wsId, primary.id),
        // 合格証を出していない走行は問い合わせない（404 がコンソールに赤エラーで出るため）
        primary.certificateId === null ? Promise.resolve(null) : api.rehearsalCertificate(wsId, primary.id),
        api.rehearsalCases(wsId, askId).catch(() => ({ items: [] as RehearsalCase[] })),
        Promise.all(recertify.map((r) => api.rehearsalResult(wsId, r.id))),
        // 本番から足した試験は担当の仕事に入る（再リハーサルの行の題・「本番から」の印）
        Promise.all(jobIds.map((j) => api.jobRehearsalCases(wsId, j).catch(() => ({ items: [] as RehearsalCase[] })))),
        previousRun === null ? Promise.resolve(null) : api.rehearsalResult(wsId, previousRun.id).catch(() => null),
      ]);
      if (!fresh()) return;
      // 自分の悪い日は結果の userCases に入って返る（走行ごとの1件）。自動の再リハーサルの行は依頼の走行の行のあとに足す
      const rows = askScenarioRows(
        { id: primary.id, result },
        recertify.map((r, i) => ({ id: r.id, result: recertResults[i]! })),
      );
      let previous: PreviousRun | null = null;
      if (previousRun !== null && previousResult !== null) {
        const prevRows = previousResult.scenarios.map((x) => fromResultRow(x, previousRun.id)).sort((a, b) => a.ordinal - b.ordinal);
        previous = { rows: prevRows, prevented: prevRows.reduce((n, r) => n + (r.preventedDamageJpy ?? 0), 0) || (previousResult.preventedDamageJpy ?? 0), counts: previousResult.counts };
      }
      setNone(false);
      setState({
        primary,
        recertify,
        result,
        rows,
        certificate,
        cases: new Map([...cases.items, ...jobCases.flatMap((c) => c.items)].map((c) => [c.id, c])),
        runIds: new Set([primary.id, ...result.userCases.map((u) => u.runId), ...recertify.map((r) => r.id)]),
        active: ACTIVE.has(primary.status) || result.userCases.some((u) => ACTIVE.has(u.runStatus)) || recertify.some((r) => ACTIVE.has(r.status)),
        previous,
      });
      setError(null);
    } catch (e) {
      if (fresh()) setError(describeError(e));
    }
  }, [wsId, askId]);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  // 合格証が切れている間は、自動の再リハーサルが始まる・終わるのを見直しで拾う（始まりの事象がないため。上限つき）。
  // 画面が隠れている間は飛ばし、戻ったときに1回取る
  const revoked = summary?.certificateState === "revoked";
  useEffect(() => {
    if (!revoked) return;
    let n = 0;
    const id = setInterval(() => {
      if (document.hidden) return;
      n += 1;
      if (n > RECERTIFY_POLL_MAX) return clearInterval(id);
      void load();
    }, RECERTIFY_POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [revoked, load]);

  const reloadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 300);
  }, [load]);

  useWorkspaceEvent((type, data) => {
    if (type === "reset") return void load();
    if (type === "rehearsal.phase" && data && typeof data === "object") {
      const { line, runId } = data as { line?: unknown; runId?: unknown };
      // 別の走行の段階の文を出さない：runId のある事象はこの依頼の走行のものだけ（開始・生成の段階は runId がないので従来どおり）
      const mine = typeof runId !== "string" || (state?.runIds.has(runId) ?? false);
      if (typeof line === "string" && mine) setPhase(line);
    }
    if (type === "rehearsal.scenario") {
      const vm = fromEvent(data);
      if (!vm) return;
      // 知っている走行なら1件ずつ足す。知らない走行（再試験・新しい悪い日）なら取り直す
      setState((s) => (s && s.runIds.has(vm.runId) ? { ...s, rows: upsertScenario(s.rows, vm) } : s));
      reloadSoon();
    }
    if (type === "rehearsal.run") {
      setPhase(null);
      reloadSoon();
    }
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = killSwitchEngaged || !online || busy;
  const start = (): void => {
    setStartingAt(new Date().toISOString());
    void run(() => api.startRehearsal(wsId, askId)).finally(() => setStartingAt(null));
  };

  if (none) {
    return (
      <section className="block rehearsal card">
        <div className="rehearsal-head">
          <h2 className="block-title">安全チェック</h2>
        </div>
        <p className="muted rehearsal-lede">まだ試していません。任せる前に、Gemini が悪い日を作って、ちゃんと止まるかを試します。</p>
        <button type="button" className="btn btn-ghost rehearsal-main" disabled={blocked} onClick={start}>
          安全チェックを始める
        </button>
        {startingAt && <GeneratingNote since={startingAt} />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }
  if (!state) {
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : null;
  }
  return <Body summary={summary} state={state} phase={phase} error={error} blocked={blocked} onRun={run} onStart={start} startingAt={startingAt} wsId={wsId} />;
}

/** 上から順に、まだ塞がれていない状況を塞ぐ提案だけを選ぶ（同じ穴を塞ぐ代替の提案は重ねて適用しない） */
export function coverProposals(proposals: readonly TighteningProposal[]): TighteningProposal[] {
  const covered = new Set<string>();
  const picked: TighteningProposal[] = [];
  for (const p of proposals) {
    if (!p.fixes.some((f) => !covered.has(f))) continue;
    picked.push(p);
    for (const f of p.fixes) covered.add(f);
  }
  return picked;
}

/**
 * Gemini が悪い日を作っている間（走行ができるまで）の1行。経過秒は1秒ごとに進むが、読み上げ領域（role=status）の文は固定にし、
 * 経過秒だけを aria-hidden にして毎秒の読み上げを避ける
 */
function GeneratingNote({ since }: { since: string }) {
  const elapsed = useElapsedSeconds(since, true);
  const p = generatingParts(elapsed ?? 0);
  return (
    <p className="muted wait-line" role="status">
      {p.name}
      <span aria-hidden="true"> {p.elapsed}</span>
      {p.note}
    </p>
  );
}

/**
 * 走っている間の1行（「再試験中 · 12秒経過（目安 約30秒） · 段階」）。経過秒の再描画をこの小部品に閉じ込める。
 * 目安のない走行（自分の悪い日など）は段階の文か固定の1行
 */
function WaitLine({ run, running, caseCount, phase }: { run: RehearsalRun; running: boolean; caseCount: number | null; phase: string | null }) {
  const elapsed = useElapsedSeconds(run.startedAt ?? run.createdAt, running);
  const p = elapsed === null ? null : elapsedParts(run.trigger, elapsed, caseCount);
  if (p === null) {
    return (
      <p className="muted wait-line" role="status">
        {plainPhaseLine(phase) ?? "状況を1件ずつ試しています"}
      </p>
    );
  }
  return (
    <p className="muted wait-line" role="status">
      {p.name}
      <span aria-hidden="true"> · {p.elapsed}</span>
      {p.note}
      {phase ? ` · ${plainPhaseLine(phase)}` : ""}
    </p>
  );
}

function Body({
  summary,
  state,
  phase,
  error,
  blocked,
  onRun,
  onStart,
  startingAt,
  wsId,
}: {
  summary: AskRehearsalView | null;
  state: State;
  phase: string | null;
  error: string | null;
  blocked: boolean;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
  onStart: () => void;
  startingAt: string | null;
  wsId: string;
}) {
  const { primary, recertify, result, rows, certificate, cases, active, previous } = state;
  const [certOpen, setCertOpen] = useState(false);
  const [sumOpen, setSumOpen] = useState(false);
  const [text, setText] = useState("");
  // 「こんな日も試す」の例文（表示のたびに1つ。入口と同じ仕組み）
  const [placeholder] = useState(() => userCasePlaceholder());
  const [restartOpen, setRestartOpen] = useState(false);
  const { workspace } = useWorkspace();
  // 走っている間の経過秒（目安のある走行：再試験・自動の再リハーサルだけ）。担当の仕事の再リハーサルが走っていればそちら
  const timed = recertify.find((r) => ACTIVE.has(r.status)) ?? primary;
  const timedActive = ACTIVE.has(timed.status);
  // Gemini が作った悪い日の件数（生成の記録が 0・欠けなら走行の状況の件数。それもなければ出さない）
  const caseCount = generatedCount(result.generator?.count, result.scenarios.length);
  const generatorLine = result.generator
    ? generatorText(result.generator, primary.trigger === "initial" ? caseCount : null, result.generator.costUsd === null ? null : formatUsd(result.generator.costUsd))
    : null;
  // 事前に走らせた結果を台本で再現したもの（Gemini を呼んでいない）：費用 0 の印と、本物で走らせるボタンを出す
  const scripted = isScriptedRun(primary);

  // 依頼の走行の行 → ほかの走行の行。再試験の間は前の走行の行を薄く残し、同じ状況の新しい行から順に置き換える
  const sorted = useMemo(() => {
    const cur = [...rows].sort((a, b) => (a.runId === b.runId ? a.ordinal - b.ordinal : a.runId === primary.id ? -1 : 1));
    return previous ? mergeRetestRows(previous.rows, cur) : cur;
  }, [rows, primary.id, previous]);
  const primaryRows = rows.filter((r) => r.runId === primary.id);
  const progress = previous ? retestProgress(previous.rows, primaryRows) : null;
  // 走っている間の進み（細い線と「3 / 8 件」）。再試験は前の走行と比べた件数、依頼の走行は作られた悪い日の件数に対して出す
  const primaryDone = retestProgress([], primaryRows).done;
  // まず3件 → 途中結果（暫定）→ 残りは裏で（Issue #12）
  // 母数は、この依頼の外されていない試験の件数（用意した依頼の再現や再度の起動では、作った件数より多く走るため）。取れなければ作った件数
  const askCaseCount = primary.askId === null ? 0 : [...cases.values()].filter((c) => c.askId === primary.askId).length;
  const firstNote = firstBatchNote({ trigger: primary.trigger, active: primary.status === "running", scripted, done: primaryDone, total: askCaseCount > 0 ? askCaseCount : caseCount });
  const runProgress = progress
    ? { done: progress.done, total: progress.total, label: `再試験中 ${progress.done} / ${progress.total} 件` }
    : ACTIVE.has(primary.status) && caseCount !== null && caseCount > 0
      ? { done: Math.min(primaryDone, caseCount), total: caseCount, label: `${Math.min(primaryDone, caseCount)} / ${caseCount} 件` }
      : null;
  const prevented = rows.reduce((n, r) => n + (r.preventedDamageJpy ?? 0), 0) || (result.preventedDamageJpy ?? 0);
  // 面の数字：再試験の間は前の値を薄く出す（終わると新しい値に変わる）
  const shown = previous ? { prevented: previous.prevented, counts: previous.counts } : { prevented, counts: result.counts };
  const proposals: TighteningProposal[] = result.proposals;
  const picked = useMemo(() => coverProposals(proposals), [proposals]);
  // 止めた規則の貢献（防いだ額の順。上位3件）と、一度も発動しなかった規則。データがなければ何も出さない
  const attribution = summary?.attribution ?? null;
  const attributionTop = attribution?.contributions.slice(0, 3) ?? [];
  const unfired = attribution?.unfiredGuards ?? [];

  const certActive = active || summary?.recertifying === true;
  const certLabel = certificateLabel(summary, certActive);
  const certClass = `cert-state is-${certificateTone(summary, certActive)}`;

  // 区画の最上部の3行（走っている間は何が起きているか、終わったら何が分かったか）
  const summaryLines = plainSummaryLines({
    summary,
    counts: shown.counts,
    preventedJpy: shown.prevented,
    primaryTrigger: primary.trigger,
    primaryStatus: primary.status,
    runningTrigger: timedActive ? timed.trigger : summary?.recertifying === true ? "recertify" : null,
    caseCount: progress?.total ?? caseCount,
    recertified: recertify.some((r) => r.status === "done"),
    incidentAdded: [...cases.values()].some((c) => c.source === "incident"),
  });

  const mark = (caseId: string): string | null => {
    const s = cases.get(caseId)?.source;
    return s === "user" ? "あなたの悪い日" : s === "incident" ? "本番から" : null;
  };

  return (
    <section className="block rehearsal card">
      <div className="rehearsal-head">
        <h2 className="block-title">安全チェック</h2>
        {/* 合格証の1行：合格（緑）は押すと中身が開く。なし（灰）・切れた／走行中（琥珀）は押せないので button にしない。状態は文でも分かる */}
        {certificate ? (
          <button type="button" className={certClass} aria-expanded={certOpen} onClick={() => setCertOpen((v) => !v)}>
            <span>{certLabel}</span>
            <span className="cert-chevron">
              <Chevron open={certOpen} />
            </span>
          </button>
        ) : (
          <span className={certClass} role="status">
            {certLabel}
          </span>
        )}
      </div>
      {certOpen && certificate && (
        <dl className="kv cert-kv">
          <dt>ポリシー</dt>
          <dd className="mono">{certificate.policyHash.slice(0, 12)}</dd>
          <dt>モデル</dt>
          <dd>{certificate.modelId}</dd>
          <dt>試験のハッシュ</dt>
          <dd className="mono">{certificate.caseSetHash.slice(0, 12)}</dd>
          <dt>記録のハッシュ</dt>
          <dd className="mono">{certificate.certificateHash.slice(0, 12)}</dd>
          {certificate.auditSeq !== null && (
            <>
              <dt>監査ログ</dt>
              <dd>
                {/* 監査ログの画面（SCR-010）で、その行を強調して開く */}
                <Link to={`/audit?seq=${certificate.auditSeq}`} className="link">
                  #{certificate.auditSeq}
                </Link>
              </dd>
            </>
          )}
        </dl>
      )}
      {summaryLines.length > 0 && (
        <div className="plain-summary">
          {summaryLines.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
      {scripted ? (
        <div className="scripted-mark card-inset">
          <p className="scripted-title">{SCRIPTED_MARK}</p>
          <p className="muted small">{SCRIPTED_NOTE}</p>
          <button type="button" className="btn btn-primary scripted-run" disabled={blocked || active} onClick={onStart}>
            本物の Gemini で走らせる
          </button>
          <p className="muted small rerun-note">
            {REAL_RUN_NOTE} · {rerunNote(caseCount)}
          </p>
          {startingAt && <GeneratingNote since={startingAt} />}
        </div>
      ) : (
        generatorLine && <p className="muted gemini-line">{generatorLine}</p>
      )}
      {active && <WaitLine run={timed} running={timedActive} caseCount={timed.id === primary.id ? caseCount : null} phase={phase} />}
      {firstNote && <p className="muted small first-batch-note" role="status">{firstNote}</p>}
      {runProgress && (
        <div className="run-progress">
          <div
            className="run-progress-track"
            role="progressbar"
            aria-label="安全チェックの進み"
            aria-valuemin={0}
            aria-valuemax={runProgress.total}
            aria-valuenow={runProgress.done}
            aria-valuetext={runProgress.label}
          >
            <span className="run-progress-fill" style={{ width: `${runProgress.total > 0 ? Math.min(100, (runProgress.done / runProgress.total) * 100) : 0}%` }} />
          </div>
          <p className="muted small run-progress-text" aria-hidden="true">
            {runProgress.label}
          </p>
        </div>
      )}

      <dl className="meters">
        <div className={previous ? "meter meter-main is-stale" : "meter meter-main"}>
          <dt>防いだ損害</dt>
          <dd>{formatYen(shown.prevented)}</dd>
        </div>
        {shown.counts && shown.counts.total > 0 && (
          <>
            <div className={previous ? "meter is-stale" : "meter"}>
              <dt>止めた</dt>
              <dd>{shown.counts.stoppedByKernel + shown.counts.stoppedByAgent}件</dd>
            </div>
            <div className={["meter", shown.counts.withControl.slipped > 0 ? "meter-bad" : "is-zero", previous ? "is-stale" : ""].filter(Boolean).join(" ")}>
              <dt>
                <WithTerm text="すり抜けた" term="すり抜けた" />
              </dt>
              <dd>{shown.counts.withControl.slipped}件</dd>
            </div>
          </>
        )}
      </dl>
      <button type="button" className="btn btn-ghost loss-toggle" aria-expanded={sumOpen} onClick={() => setSumOpen((v) => !v)}>
        防いだ損害の内訳 <Chevron open={sumOpen} />
      </button>
      {sumOpen && (
        <ul className="plain muted loss-lines">
          {sorted
            .filter((r) => (r.preventedDamageJpy ?? 0) > 0)
            .map((r) => (
              <li key={r.id}>
                {[faultIdsText(r.faultIds), cases.get(r.caseId)?.title ?? ""].filter(Boolean).join(" ")}：統制なしの損害 {formatYen(r.withoutControlDamageJpy ?? 0)} − 統制ありの損害 {formatYen(r.damageJpy ?? 0)} = {formatYen(r.preventedDamageJpy ?? 0)}
              </li>
            ))}
        </ul>
      )}

      {(attributionTop.length > 0 || unfired.length > 0) && (
        <div className="attrib">
          {attributionTop.length > 0 && (
            <>
              <p className="muted small attrib-title">止めた規則の貢献</p>
              <ul className="plain attrib-lines">
                {attributionTop.map((c, i) => (
                  <li key={i}>
                    {c.ruleLabel} — {c.preventedDamageJpy > 0 ? `${c.stoppedCount}件止めて ${formatYen(c.preventedDamageJpy)} を防いだ` : `${c.stoppedCount}件止めた`}
                  </li>
                ))}
              </ul>
            </>
          )}
          {unfired.length > 0 && <p className="muted small attrib-unfired">一度も発動しなかった規則：{unfired.join("、")}</p>}
        </div>
      )}

      {proposals.length > 0 && (
        <div className="proposal card-inset">
          <div className="proposal-lines">
            {proposals.map((p) => (
              <p key={p.id}>
                <WithTerm text={p.label} term="ガード" />
              </p>
            ))}
          </div>
          {/* 提案は同じ穴を別の方法で塞ぐ代替も含む。上から順に、まだ塞がれていない穴を塞ぐものだけを全部適用し、再試験は最後に1回だけ（途中で始めると残りの提案が消える）。
              デモの主役の操作なので塗り（btn-primary） */}
          <button
            type="button"
            className="btn btn-primary proposal-apply"
            disabled={blocked || active}
            onClick={() =>
              void onRun(async () => {
                for (const [i, p] of picked.entries()) await api.applyTightening(wsId, primary.id, p.id, i === picked.length - 1);
              })
            }
          >
            {picked.length > 1 ? `${picked.length}件を適用して再試験` : "適用"}
          </button>
        </div>
      )}

      <ul className="plain scenarios">
        {sorted.map((r) => (
          <ScenarioRow key={r.id} r={r} title={cases.get(r.caseId)?.title ?? null} mark={mark(r.caseId)} />
        ))}
      </ul>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          void onRun(async () => {
            await api.startUserCase(wsId, primary.id, t);
            setText("");
          });
        }}
      >
        <label htmlFor="user-case">こんな日も試す</label>
        <div className="own-answer">
          <input id="user-case" value={text} maxLength={500} placeholder={placeholder} aria-describedby="user-case-note" onChange={(e) => setText(e.target.value)} disabled={blocked} />
          <button type="submit" className="btn btn-ghost" disabled={blocked || !text.trim()}>
            試す
          </button>
        </div>
        <p id="user-case-note" className="muted small">
          {USER_CASE_NOTE}
        </p>
      </form>
      {result.userCases.map((u) => (
        <UserCaseLine key={u.id} u={u} blocked={blocked} onCancel={() => void onRun(() => api.cancelUserCase(wsId, primary.id, u.id))} />
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {/* 台本の結果の間は、上の [本物の Gemini で走らせる] が同じ操作なので、ここの [もう一度] は出さない */}
      {!scripted && (
        <div className="rerun">
          {/* 締める提案がなければ、次にやることはこれなので塗り（提案があるときは [適用] が塗り） */}
          <button type="button" className={proposals.length > 0 ? "btn btn-ghost" : "btn btn-primary"} disabled={blocked || active} onClick={onStart}>
            もう一度、全部試す
          </button>
          <p className="muted small rerun-note">{rerunNote(caseCount)}</p>
        </div>
      )}
      {!scripted && startingAt && <GeneratingNote since={startingAt} />}
      {workspace.guest && summary?.certificateState === "valid" && !active && (
        <button type="button" className="link-small" onClick={() => setRestartOpen(true)}>
          最初からやり直す
        </button>
      )}
      <Glossary />
      {restartOpen && <RestartSheet onClose={() => setRestartOpen(false)} />}
    </section>
  );
}

function UserCaseLine({ u, blocked, onCancel }: { u: UserCaseResult; blocked: boolean; onCancel: () => void }) {
  const running = u.status === "running" && ACTIVE.has(u.runStatus);
  return (
    <p className="interp card-inset" role="status">
      {u.interpretation ? interpretationText(u.interpretation) : u.status === "cancelled" ? "やめました" : USER_CASE_UNMATCHED}{" "}
      {running && (
        <button type="button" className="btn btn-ghost" disabled={blocked} onClick={onCancel}>
          やめる
        </button>
      )}
    </p>
  );
}

/** 損害の式と元の値（BR-79）。当てはまらない式は出さず、0円の行は式だけ */
/** 注記の元の値（D-110：今回送られた内容と、あなたが送らなかった内容を並べる。R-73・BR-79 と同じ「元の値まで開ける」） */
function NoteValues({ note }: { note: IncidentNote }) {
  const rows = (items: IncidentNoteItem[]) =>
    items.map((i, n) => (
      <div key={n}>
        <dt>{i.name ?? i.sku ?? "品目"}</dt>
        <dd>
          {i.quantity ?? "?"}
          {i.unit ?? ""} · 単価 {i.unitPrice === null ? "?" : formatYen(i.unitPrice)}
        </dd>
      </div>
    ));
  return (
    <div className="breakdown">
      <p className="detail-head muted">送られた内容{note.destination ? `（${note.destination}）` : ""}</p>
      <dl className="kv">{rows(note.sent)}</dl>
      <p className="detail-head muted">あなたが送らなかった内容</p>
      <dl className="kv">{rows(note.rejected)}</dl>
      {note.ruleLabel && <p className="muted small">通したルール：{note.ruleLabel}</p>}
    </div>
  );
}

function Breakdown({ title, b }: { title: string; b: DamageBreakdownView }) {
  const items = b.items.filter((i) => i.applied && (i.amountJpy > 0 || i.lines.length > 0));
  return (
    <div className="breakdown">
      <p className="detail-head muted">
        {title}：{formatYen(b.totalJpy)}
      </p>
      {items.map((i) => (
        <div key={i.kind} className="detail-block">
          <p>
            {i.label}　{formatYen(i.amountJpy)}
          </p>
          <p className="muted small">式：{i.formula}</p>
          {i.lines.map((l, n) => (
            <div key={n}>
              <p className="small">
                {l.label}：{l.expression}
              </p>
              <dl className="kv">
                {l.terms.map((t) => (
                  <div key={t.key}>
                    <dt>{t.label}</dt>
                    {/* 数量（qty）は単位が品目で違う（kg・個など）ので、単位を付けずに数だけ出す */}
                    <dd>{t.unit === "jpy" && typeof t.value === "number" ? formatYen(t.value) : t.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ))}
      {b.secretLeaks.count > 0 && <p className="failed small">秘密の流出：{b.secretLeaks.count}件（金額にはしていません）</p>}
    </div>
  );
}

/** 状況の1行。開ける行（損害の内訳がある）だけ button にして右端に ＞／∧、開けない行は通常の要素。すり抜けは --red-bg の面、前の走行の行は薄く */
function ScenarioRow({ r, title, mark }: { r: ScenarioVM; title: string | null; mark: string | null }) {
  const [open, setOpen] = useState(false);
  const note = r.incidentNote ?? null;
  const canOpen = r.breakdown !== null || r.withoutBreakdown !== null || note !== null;
  const cls = ["scenario", r.verdict === "fail" ? "scenario-fail" : "", r.stale ? "scenario-stale" : ""].filter(Boolean).join(" ");
  const line = <span className={r.verdict === "fail" ? "failed" : undefined}>{scenarioLine(r, title)}</span>;
  return (
    <li className={cls}>
      {(mark || r.stale) && <span className="mark">{[mark, r.stale ? "前の結果" : null].filter(Boolean).join(" · ")}</span>}
      {canOpen ? (
        <button type="button" className="row-toggle plain-toggle scenario-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {line}
          <span className="scenario-chevron">
            <Chevron open={open} />
          </span>
        </button>
      ) : (
        <p className="scenario-line">{line}</p>
      )}
      {note && <p className="scenario-note small">{note.text}</p>}
      {open && note && <NoteValues note={note} />}
      {open && r.withoutBreakdown && <Breakdown title="統制がなければ" b={r.withoutBreakdown} />}
      {open && r.breakdown && <Breakdown title="統制ありの損害" b={r.breakdown} />}
    </li>
  );
}
