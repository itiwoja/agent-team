// 読み込み中の骨（ページの形に近い灰色の面）。文字だけの「読み込んでいます…」だと、読み終わったとき形が一気に入れ替わるので、先に形を見せる。
// 読み上げは sr-only の文字が受け持つので、骨そのものは aria-hidden。光の流れ（シマー）は styles.css の .skel 系で、reduced-motion では止まる

type CardSize = "lg" | "sm";

/** カード型の骨（角丸・--surface の地・中に線）。head を付けると上に見出しの線が1本つく */
export function SkeletonCards({ count = 3, sizes, head = false }: { count?: number; sizes?: CardSize[]; head?: boolean }) {
  return (
    <div className="skel-wrap" role="status">
      <span className="sr-only">読み込んでいます</span>
      <div className="skel" aria-hidden="true">
        {head && <span className="skel-line skel-head" />}
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`skel-card${sizes?.[i] === "lg" ? " is-lg" : sizes?.[i] === "sm" ? " is-sm" : ""}`}>
            <span className="skel-line skel-title" />
            <span className="skel-line" />
            <span className="skel-line skel-short" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 行の骨（線だけ）。heading を付けると上に見出しの線が1本つく */
export function SkeletonLines({ lines = 3, heading = false }: { lines?: number; heading?: boolean }) {
  return (
    <div className="skel-wrap" role="status">
      <span className="sr-only">読み込んでいます</span>
      <div className="skel skel-rows" aria-hidden="true">
        {heading && <span className="skel-line skel-head" />}
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className={`skel-line${i === lines - 1 ? " skel-short" : ""}`} />
        ))}
      </div>
    </div>
  );
}
