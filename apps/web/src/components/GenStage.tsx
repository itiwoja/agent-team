// エージェント生成の見せ方（入口と全画面共通の「頼む」シートで同じにする）。生成中はたまご、編成ができたら担当が1人ずつ生まれる
import type { GenState } from "../lib/generation";
import { Link } from "../lib/router";
import { Avatar } from "./Avatar";

/** 生成中のたまご（ゆらゆら揺れて、ひびが入る。編成ができると担当が生まれる） */
export function Egg() {
  return (
    <span className="gen-egg" aria-hidden="true">
      <svg viewBox="0 0 64 72" width="72" height="81" focusable="false">
        <ellipse cx="32" cy="68" rx="16" ry="2.6" fill="currentColor" opacity="0.1" />
        <g className="gen-egg-body">
          <path d="M32 6C46 6 54 30 54 44C54 58 44 66 32 66S10 58 10 44C10 30 18 6 32 6Z" fill="#fff7e6" stroke="#d9b98a" strokeWidth="1.8" />
          <circle cx="22" cy="40" r="3.4" fill="#ffd2a8" />
          <circle cx="40" cy="28" r="2.6" fill="#ffd2a8" />
          <circle cx="42" cy="50" r="3.8" fill="#ffd2a8" />
          <path className="gen-egg-crack" d="M18 34L24 30L28 36L34 29L39 35L45 31" fill="none" stroke="#b8925c" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
    </span>
  );
}

/** できた編成（担当が1人ずつ生まれる）。押すとすぐ依頼のページへ */
export function GenFormation({ state, heading = "h1" }: { state: GenState; heading?: "h1" | "h2" }) {
  const Heading = heading;
  const body = (
    <>
      <ul className="gen-members" aria-label="できた編成">
        {state.members.map((m, i) => (
          <li key={m.key} style={{ ["--i" as string]: i }} className="gen-member">
            <Avatar name={m.agentName} mood={m.isNew ? "done" : "idle"} size={52} className="avatar-pop" />
            <div>
              <h2 className="gen-name">{m.agentName}</h2>
              <h3 className="gen-summary">{m.summary}</h3>
              <p className="muted">{m.isNew ? "新しく作りました" : "いつものエージェント"}</p>
            </div>
          </li>
        ))}
      </ul>
      {state.shapeLine && (
        <p className="gen-shape" style={{ ["--i" as string]: state.members.length }}>
          {state.shapeLine}
        </p>
      )}
    </>
  );
  return (
    <section aria-live="polite" className="gen">
      <Heading className="sr-only">エージェントができました</Heading>
      {state.askId ? (
        <Link to={`/asks/${state.askId}`} className="gen-link">
          {body}
          <span className="sr-only">この依頼のページを開く</span>
        </Link>
      ) : (
        body
      )}
    </section>
  );
}
