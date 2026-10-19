// エージェントのアイコン（名前から色と持ち物が決まる SVG）。キャラは 1 種類で、まるい体に短い足、
// 顔は暗いスクリーンに光る目。口はなく、表情は目だけで担当の段の状態を表す。
// 読み上げは名前の文字が受け持つので、アイコンそのものは aria-hidden
import { avatarTraits, type AvatarMood, type AvatarPalette, type AvatarProp } from "../lib/avatar";

const INK = "#3a2e2a";
const SCREEN = "#36333a";
const GLOW = "#e4ece6";

const BODY = "M32 18C46 18 54 26.5 54 38C54 49.5 46 55 32 55C18 55 10 49.5 10 38C10 26.5 18 18 32 18Z";
const TOP = 18;
const EYE_Y = 36.5;

export function Avatar({ name, mood = "idle", size = 40, className }: { name: string; mood?: AvatarMood; size?: number; className?: string }) {
  const t = avatarTraits(name);
  const p = t.palette;
  const part = { fill: p.fill, stroke: p.line, strokeWidth: 1.4, strokeLinejoin: "round" as const };
  return (
    <span className={["avatar", `mood-${mood}`, className].filter(Boolean).join(" ")} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 64 64" width={size} height={size} focusable="false">
        <ellipse className="avatar-shadow" cx="32" cy="60.5" rx="16" ry="2.4" fill={INK} opacity="0.12" />
        <g className="avatar-figure">
          {/* 短い足（体の後ろに置く） */}
          <rect x="20.5" y="49" width="8" height="10" rx="4" {...part} fill={p.shade} />
          <rect x="35.5" y="49" width="8" height="10" rx="4" {...part} fill={p.shade} />
          {mood === "approval" && <Hand palette={p} />}
          {t.prop === "sprout" && <Sprout />}
          <path d={BODY} {...part} />
          {/* 顔のスクリーン */}
          <rect x="16.5" y="26.5" width="31" height="20" rx="10" fill={SCREEN} />
          <g className="avatar-eyes">
            <Eye x={26} y={EYE_Y} side="l" mood={mood} />
            <Eye x={38} y={EYE_Y} side="r" mood={mood} />
          </g>
          {t.prop !== "sprout" && <Prop prop={t.prop} palette={p} top={TOP} />}
        </g>
        <MoodMark mood={mood} />
      </svg>
    </span>
  );
}

/** 光る目。ふだんは縦長のカプセル、表情で形が変わる */
function Eye({ x, y, side, mood }: { x: number; y: number; side: "l" | "r"; mood: AvatarMood }) {
  const line = { fill: "none", stroke: GLOW, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (mood === "done") return <path d={`M${x - 3} ${y + 1.5}Q${x} ${y - 3} ${x + 3} ${y + 1.5}`} {...line} />;
  if (mood === "stopped") return <path d={`M${x - 2.6} ${y + 1}H${x + 2.6}`} {...line} />;
  if (mood === "failed") {
    const d = side === "l" ? `M${x - 2} ${y - 2.6}L${x + 2} ${y}L${x - 2} ${y + 2.6}` : `M${x + 2} ${y - 2.6}L${x - 2} ${y}L${x + 2} ${y + 2.6}`;
    return <path d={d} {...line} />;
  }
  // 確認待ちは丸い目で少し上を見る
  if (mood === "approval")
    return (
      <g className="avatar-eye">
        <circle cx={x} cy={y - 1} r="2.8" fill={GLOW} />
      </g>
    );
  return (
    <g className="avatar-eye">
      <rect x={x - 2.1} y={y - 3.5} width="4.2" height="7" rx="2.1" fill={GLOW} />
    </g>
  );
}

/** 持ち物が芽のとき：頭に芽が生える */
function Sprout() {
  const top = TOP;
  return (
    <g className="avatar-sprout">
      <path d={`M32 ${top + 1}Q31.5 ${top - 4} 32 ${top - 6}`} fill="none" stroke="#5d7a55" strokeWidth="1.8" strokeLinecap="round" />
      <path d={`M32 ${top - 5}C28 ${top - 10} 23 ${top - 8} 24 ${top - 5}C26 ${top - 3} 30 ${top - 3} 32 ${top - 5}Z`} fill="#9cb592" stroke="#5d7a55" strokeWidth="1.1" />
      <path d={`M32 ${top - 6}C35 ${top - 12} 41 ${top - 10} 40 ${top - 7}C38 ${top - 4} 34 ${top - 4} 32 ${top - 6}Z`} fill="#9cb592" stroke="#5d7a55" strokeWidth="1.1" />
    </g>
  );
}

/** 確認待ち：片手を挙げる */
function Hand({ palette }: { palette: AvatarPalette }) {
  return (
    <g className="avatar-hand">
      <path d="M13 40Q7 34 7.5 26" fill="none" stroke={palette.line} strokeWidth="5.4" strokeLinecap="round" />
      <path d="M13 40Q7 34 7.5 26" fill="none" stroke={palette.fill} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="7.5" cy="24.5" r="3.6" fill={palette.fill} stroke={palette.line} strokeWidth="1.4" />
    </g>
  );
}

/** 持ち物（名前の語で選ぶ）。体の右下に持つ（雲だけ頭の上） */
function Prop({ prop, palette, top }: { prop: Exclude<AvatarProp, "sprout">; palette: AvatarPalette; top: number }) {
  const s = { stroke: palette.line, strokeWidth: 1.4, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  switch (prop) {
    case "envelope":
      return (
        <g className="avatar-prop">
          <rect x="42" y="45" width="18" height="12.5" rx="2" fill="#f3efe8" {...s} />
          <path d="M42.6 46L51 52L59.4 46" fill="none" {...s} />
        </g>
      );
    case "box":
      return (
        <g className="avatar-prop">
          <rect x="42" y="44" width="17" height="14" rx="1.5" fill="#c9a77c" stroke="#7d5d38" strokeWidth="1.4" />
          <path d="M42 48.5H59M50.5 44V48.5" stroke="#7d5d38" strokeWidth="1.2" />
        </g>
      );
    case "clipboard":
      return (
        <g className="avatar-prop">
          <rect x="44" y="40" width="14" height="18" rx="2" fill="#f3efe8" {...s} />
          <rect x="48" y="38" width="6" height="4" rx="1" fill={palette.line} />
          <path d="M47 46.5L48.5 48L51 45.5M47 52.5L48.5 54L51 51.5M52.5 47H55.5M52.5 53H55.5" fill="none" {...s} strokeWidth="1.1" />
        </g>
      );
    case "news":
      return (
        <g className="avatar-prop">
          <rect x="41" y="44" width="19" height="13.5" rx="1.5" fill="#f3efe8" {...s} />
          <rect x="43.5" y="46.5" width="6" height="4.5" fill={palette.shade} />
          <path d="M51.5 47H57.5M51.5 50H57.5M43.5 54H57.5" {...s} strokeWidth="1.1" />
        </g>
      );
    case "cloud":
      return (
        <g className="avatar-prop avatar-cloud">
          <path d={`M42 ${top + 1}a4.5 4.5 0 0 1 2-8.6a6 6 0 0 1 11.4 1.4a3.8 3.8 0 0 1 0.6 7.2Z`} fill="#f3efe8" {...s} />
        </g>
      );
    case "calendar":
      return (
        <g className="avatar-prop">
          <rect x="43" y="42" width="16" height="15.5" rx="2" fill="#f3efe8" {...s} />
          <path d="M43 46.5H59" {...s} />
          <rect x="43.7" y="42.7" width="14.6" height="3.4" rx="1" fill="#c98f82" />
          <circle cx="47.5" cy="50.5" r="1" fill={palette.line} />
          <circle cx="51" cy="50.5" r="1" fill={palette.line} />
          <circle cx="54.5" cy="50.5" r="1" fill="#c98f82" />
          <circle cx="47.5" cy="54" r="1" fill={palette.line} />
        </g>
      );
    case "wrench":
      return (
        <g className="avatar-prop">
          <path d="M45.5 58L54 48" stroke="#8a8f96" strokeWidth="4" strokeLinecap="round" />
          <path d="M51.5 45.2a5 5 0 0 1 7.6-3.2l-3 3 1.6 2.6 2.8-0.6a5 5 0 0 1-7.4 4.6Z" fill="#b3b6ba" stroke="#65696f" strokeWidth="1.2" strokeLinejoin="round" />
        </g>
      );
    case "coin":
      return (
        <g className="avatar-prop">
          <circle cx="52" cy="50.5" r="7" fill="#d6c286" stroke="#86733f" strokeWidth="1.4" />
          <circle cx="52" cy="50.5" r="4.6" fill="none" stroke="#b39f62" strokeWidth="1.1" />
          <path d="M49.6 47.6L52 50.6L54.4 47.6M52 50.6V54M50 51.4H54" fill="none" stroke="#86733f" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
  }
}

/** 表情に添える印（動いている＝汗と点々、確認待ち＝？、済み＝きらり、止めた＝zz、失敗＝もやもや） */
function MoodMark({ mood }: { mood: AvatarMood }) {
  switch (mood) {
    case "running":
      return (
        <g className="avatar-mark avatar-dots">
          <circle cx="50" cy="9" r="2" fill="var(--amber, #a15c00)" />
          <circle cx="55.5" cy="9" r="2" fill="var(--amber, #a15c00)" />
          <circle cx="61" cy="9" r="2" fill="var(--amber, #a15c00)" />
        </g>
      );
    case "approval":
      return (
        <g className="avatar-mark avatar-question">
          <circle cx="55" cy="11" r="8" fill="var(--amber-bg, #fff3df)" stroke="var(--amber, #a15c00)" strokeWidth="1.4" />
          <path d="M52.4 8.6a2.7 2.7 0 1 1 3.8 2.5c-0.9 0.4-1.2 1-1.2 2" fill="none" stroke="var(--amber, #a15c00)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="55" cy="15.6" r="1.1" fill="var(--amber, #a15c00)" />
        </g>
      );
    case "done":
      return (
        <g className="avatar-mark avatar-sparkle">
          <path d="M55 3L56.6 8.4L62 10L56.6 11.6L55 17L53.4 11.6L48 10L53.4 8.4Z" fill="#d9c07a" stroke="#8f7a3e" strokeWidth="0.8" strokeLinejoin="round" />
        </g>
      );
    case "stopped":
      return (
        <g className="avatar-mark avatar-zz" fill="var(--muted, #6b6b6b)">
          <path d="M48 6H53L48 11H53" fill="none" stroke="var(--muted, #6b6b6b)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M55 1H59L55 5H59" fill="none" stroke="var(--muted, #6b6b6b)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    case "failed":
      return (
        <g className="avatar-mark">
          <path d="M50 10c2-4 6-4 7 0s-4 4-3 1 4-2 5 1" fill="none" stroke="var(--red, #c4271d)" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      );
    default:
      return null;
  }
}
