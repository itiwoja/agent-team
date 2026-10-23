// エージェントが生まれる全画面（オーバーレイ）。生成中（まだ誰が生まれるか分からない間）はたまごだけが揺れ、
// 名前が分かったら（agents が渡されたら）ひびが入り、1 人ずつぽんと生まれる。見た目は pack-ceremony.css の cer-* と
// entrance.css のたまご（Egg）を使い回し、段取りは lib/birth.ts（純粋な reducer）に置く。動きを抑える設定のときは
// 最初から生まれた画面を出し、「続ける」で閉じる。onDone は 1 回だけ（とばす・自動終了・続ける のどれが先でも）
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { birthDelayMs, birthLine, birthReducer, birthSeat, birthTitle, initialBirth, namedBirth, type BirthSeat, type BirthState } from "../lib/birth";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { trapTab } from "../ui/trapTab";
import { Avatar } from "./Avatar";
import { Egg } from "./GenStage";

export interface BirthAgent {
  name: string;
  summary: string;
}

/** 動きを抑える設定か（読めない環境では抑えない） */
function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 席ごとの遅れ（--i）。人数が多くても最後の席が遅すぎないよう頭打ちにする */
const MAX_STAGGER = 8;

/**
 * agents が null の間はたまごだけ（生成中）。配列が渡されたら生まれる段へ進む。
 * 生成中は閉じられない（とばす・Escape は名前が分かってから効く）
 */
export function AgentBirth({ agents, onDone, eyebrow = "新しいエージェント" }: { agents: BirthAgent[] | null; onDone: () => void; eyebrow?: string }) {
  const titleId = useId();
  const [reduced] = useState(prefersReducedMotion);
  const [state, dispatch] = useReducer(birthReducer, undefined, (): BirthState => (agents ? namedBirth(agents.length, reduced) : initialBirth));
  const dialogRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useRestoreFocus();

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const skip = () => {
    if (state.phase === "egg") return;
    dispatch({ type: "skip" });
    finish();
  };
  const skipFnRef = useRef(skip);
  skipFnRef.current = skip;

  // 名前が分かったら生まれる段へ
  const count = agents ? agents.length : null;
  useEffect(() => {
    if (count !== null) dispatch({ type: "named", total: count, reducedMotion: reduced });
  }, [count, reduced]);

  // 開いたら枠にフォーカス。名前が分かったら「とばす」（動きを抑える設定では「続ける」）へ
  const named = state.phase !== "egg";
  useEffect(() => {
    if (!named) {
      dialogRef.current?.focus({ preventScroll: true });
      return;
    }
    if (reduced && continueRef.current) {
      continueRef.current.focus();
      continueRef.current.scrollIntoView({ block: "center" });
      return;
    }
    skipRef.current?.focus({ preventScroll: true });
  }, [named, reduced]);

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

  // 次の段へ進むタイマー
  useEffect(() => {
    if (state.phase === "done") {
      finishRef.current();
      return;
    }
    const delay = birthDelayMs(state, reduced);
    if (delay === null) return;
    const id = window.setTimeout(() => dispatch({ type: "advance" }), delay);
    return () => window.clearTimeout(id);
  }, [state, reduced]);

  const list = agents ?? [];
  const names = list.map((a) => a.name);
  const cols = Math.min(Math.max(list.length, 1), 3);
  const ready = state.phase === "ready" || state.phase === "done";

  return (
    <div className="cer-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
      {named && (
        <button ref={skipRef} type="button" className="btn btn-ghost cer-skip" onClick={skip}>
          とばす
        </button>
      )}
      <div className={`cer-stage birth-stage cer-cols-${cols}`} data-phase={state.phase === "egg" ? "prepare" : state.phase}>
        <span className="cer-light" aria-hidden="true" />
        <header className="cer-head">
          <p className="cer-eyebrow">{eyebrow}</p>
          <h2 className="cer-title" id={titleId}>
            {named ? "生まれます" : "作っています"}
          </h2>
        </header>

        {named ? (
          <ul className={`cer-grid cer-cols-${cols}`} aria-label="生まれたエージェント">
            {list.map((a, i) => (
              <Seat key={`${i}:${a.name}`} agent={a} index={i} seat={birthSeat(state, i)} ready={ready} />
            ))}
          </ul>
        ) : (
          <div className="birth-egg">
            <Egg />
          </div>
        )}

        <p className="cer-live" aria-live="polite">
          {birthLine(state, names)}
        </p>

        <div className="cer-finale" aria-hidden={!ready}>
          <h3 className="cer-finale-title">{birthTitle(names)}</h3>
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

function Seat({ agent, index, seat, ready }: { agent: BirthAgent; index: number; seat: BirthSeat; ready: boolean }) {
  const style = { ["--i" as string]: Math.min(index, MAX_STAGGER) };
  return (
    <li className={`cer-desk is-${seat}`} style={style} aria-hidden={seat === "wait" ? true : undefined}>
      <div className="cer-seat">
        <div className="cer-figure">
          {seat !== "born" && <HatchEgg hatching={seat === "hatching"} />}
          {seat !== "wait" && (
            <>
              <Burst />
              <Avatar name={agent.name} mood={ready ? "done" : "idle"} size={60} className="avatar-pop" />
            </>
          )}
        </div>
        <div className="cer-text">
          <h3 className="cer-name">{agent.name}</h3>
          <p className="cer-summary">{agent.summary}</p>
        </div>
      </div>
      <span className="cer-desktop" aria-hidden="true" />
    </li>
  );
}

/** かえる番を待つたまご。かえる番になると揺れてひびが入り、ぽんと消える（PackInstallCeremony と同じ見た目） */
function HatchEgg({ hatching }: { hatching: boolean }) {
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

/** 生まれる瞬間の光の輪と小さな紙吹雪（CSS だけ） */
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
