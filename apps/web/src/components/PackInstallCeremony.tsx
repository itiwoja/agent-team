// パックを入れたときの「チームが生まれる」セレモニー（全画面のオーバーレイ）。
// 入口の生成中（たまごが揺れてひびが入り、担当がぽんと生まれる）を土台に、机が並び、1 人ずつ生まれ、
// スキル・スクリプトの札が配られ、最後にチームがそろう。段取りは lib/ceremony.ts（純粋な reducer）に置き、
// ここはタイマーと見た目だけを持つ。動きを抑える設定のときは最初から全員そろった画面を出し、「続ける」で閉じる
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { ceremonyReducer, deskStage, initialCeremony, kitTags, liveLine, nextDelayMs, type CeremonyState, type DeskStage } from "../lib/ceremony";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { TEMPLATE_LABEL } from "../lib/packLabels";
import { trapTab } from "../ui/trapTab";
import { Avatar } from "./Avatar";

export interface CeremonyAgent {
  name: string;
  summary: string;
  template: string;
  skills: string[];
  files: string[];
}

/** 動きを抑える設定か（読めない環境では抑えない） */
function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 机ごとの遅れ（--i）。人数が多くても最後の机が遅すぎないよう頭打ちにする */
const MAX_STAGGER = 8;

export function PackInstallCeremony({ packName, agents, onDone }: { packName: string; agents: CeremonyAgent[]; onDone: () => void }) {
  const titleId = useId();
  const [reduced] = useState(prefersReducedMotion);
  const [state, dispatch] = useReducer(ceremonyReducer, undefined, () => initialCeremony(agents.length, reduced));
  const dialogRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // 閉じたら開いたボタンにフォーカスを戻す（自分でフォーカスを動かす effect より前に呼ぶ）
  useRestoreFocus();

  /** onDone は 1 回だけ（とばす・自動終了・続ける のどれが先でも） */
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const skip = () => {
    dispatch({ type: "skip" });
    finish();
  };
  const skipFnRef = useRef(skip);
  skipFnRef.current = skip;

  // 開いたら「とばす」にフォーカス。動きを減らす設定では自動で閉じないので、閉じる手段の「続ける」へ（狭い画面では下にあるので、そこまで寄る）
  useEffect(() => {
    if (reduced) {
      const el = continueRef.current;
      if (el) {
        el.focus();
        el.scrollIntoView({ block: "center" });
        return;
      }
    }
    skipRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 後ろのページが動かないようにする
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape でとばす。Tab は枠の中で循環
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skipFnRef.current();
        return;
      }
      trapTab(e, dialogRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 次の段へ進むタイマー（動きを抑えるときは null で進まない）
  useEffect(() => {
    if (state.phase === "done") {
      finishRef.current();
      return;
    }
    const delay = nextDelayMs(state, agents.length, reduced);
    if (delay === null) return;
    const id = window.setTimeout(() => dispatch({ type: "advance" }), delay);
    return () => window.clearTimeout(id);
  }, [state, agents.length, reduced]);

  const cols = Math.min(Math.max(agents.length, 1), 3);
  const ready = state.phase === "ready" || state.phase === "done";
  const names = agents.map((a) => a.name);

  return (
    <div className="cer-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
      <button ref={skipRef} type="button" className="btn btn-ghost cer-skip" onClick={skip}>
        とばす
      </button>
      <div className={`cer-stage cer-cols-${cols}`} data-phase={state.phase}>
        <span className="cer-light" aria-hidden="true" />
        <header className="cer-head">
          <p className="cer-eyebrow">パックを入れました</p>
          <h2 className="cer-title" id={titleId}>
            {packName}
          </h2>
        </header>

        <ul className={`cer-grid cer-cols-${cols}`} aria-label="チームの顔ぶれ">
          {agents.map((a, i) => (
            <Desk key={`${i}:${a.name}`} agent={a} index={i} stage={deskStage(state, i)} state={state} ready={ready} />
          ))}
        </ul>

        <div className="cer-cargo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
            <path d="M5 9h14l-1 10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 9Z M9 9V7a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          パックの荷物
        </div>

        <p className="cer-live" aria-live="polite">
          {liveLine(state, names)}
        </p>

        <div className="cer-finale" aria-hidden={!ready}>
          <h3 className="cer-finale-title">{packName}のチームがそろいました</h3>
          <p className="cer-finale-line">この作業場に頼むと、すぐ動きます</p>
          {reduced && (
            <button type="button" ref={continueRef} className="btn btn-primary cer-continue" onClick={skip}>
              続ける
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Desk({ agent, index, stage, state, ready }: { agent: CeremonyAgent; index: number; stage: DeskStage; state: CeremonyState; ready: boolean }) {
  const style = { ["--i" as string]: Math.min(index, MAX_STAGGER) };
  const equipped = state.phase === "equip" || ready;
  const kit = kitTags(agent.skills, agent.files);
  return (
    <li className={`cer-desk is-${stage}`} style={style} aria-hidden={stage === "wait" ? true : undefined}>
      <div className="cer-seat">
        <div className="cer-figure">
          {stage === "wait" || stage === "hatching" ? <Egg hatching={stage === "hatching"} /> : null}
          {stage !== "wait" && (
            <>
              <Burst />
              <Avatar name={agent.name} mood={ready ? "done" : "idle"} size={60} className="avatar-pop" />
            </>
          )}
        </div>
        <div className="cer-text">
          <h3 className="cer-name">{agent.name}</h3>
          <p className="cer-summary">{agent.summary}</p>
          <span className="cer-chip">{TEMPLATE_LABEL[agent.template] ?? agent.template}</span>
        </div>
      </div>
      <span className="cer-desktop" aria-hidden="true" />
      {equipped && (kit.tags.length > 0 || kit.more > 0) && (
        <ul className="cer-kit" aria-label="持ち物">
          {kit.tags.map((t, j) => (
            <li key={`${t.kind}:${t.label}`} className={`cer-tag is-${t.kind}`} style={{ ["--j" as string]: j, ["--fx" as string]: `${((j % 3) - 1) * 36}px` }}>
              {t.label}
            </li>
          ))}
          {kit.more > 0 && (
            <li className="cer-tag is-more" style={{ ["--j" as string]: kit.tags.length, ["--fx" as string]: "0px" }}>
              ＋{kit.more}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** たまご。待っている間は静かに座り、かえる番になると揺れてひびが入り、ぽんと消える */
function Egg({ hatching }: { hatching: boolean }) {
  return (
    <span className={`cer-egg${hatching ? " is-hatching" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 64 72" width="60" height="68" focusable="false">
        <ellipse cx="32" cy="68" rx="16" ry="2.6" fill="currentColor" opacity="0.1" />
        <g className="cer-egg-body">
          <path d="M32 6C46 6 54 30 54 44C54 58 44 66 32 66S10 58 10 44C10 30 18 6 32 6Z" fill="#fff7e6" stroke="#d9b98a" strokeWidth="1.8" />
          <circle cx="22" cy="40" r="3.4" fill="#ffd2a8" />
          <circle cx="40" cy="28" r="2.6" fill="#ffd2a8" />
          <circle cx="42" cy="50" r="3.8" fill="#ffd2a8" />
          <path className="cer-egg-crack" d="M18 34L24 30L28 36L34 29L39 35L45 31" fill="none" stroke="#b8925c" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
    </span>
  );
}

const BURST_PIECES = [0, 45, 90, 135, 180, 225, 270, 315];

/** 生まれる瞬間の光の輪と小さな紙吹雪（CSS だけ。生まれたあとは見えなくなる） */
function Burst() {
  return (
    <span className="cer-burst" aria-hidden="true">
      <span className="cer-ring" />
      {BURST_PIECES.map((a, k) => (
        <span key={a} className={`cer-piece is-${k % 3}`} style={{ ["--a" as string]: `${a}deg` }} />
      ))}
    </span>
  );
}
