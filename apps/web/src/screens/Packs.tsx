// パック（`/packs`。D-116）：複数のエージェント・スキル（手順書）・スクリプトをひとまとめにした詰め合わせの棚。
// 棚（`/packs`）は言葉の検索と分類の札で絞り込み、押すとそのパックの作業場（`/packs/:packId`。screens/PackWorkspace.tsx）が開く。
// 作業場では担当が机に座って働いていて、[入れる] でエージェントがライブラリに並び、そのまま作業場から頼める
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, describeError, type PackView } from "../api";
import { Avatar } from "../components/Avatar";
import { LoadError } from "../components/LoadError";
import { SkeletonCards } from "../components/Skeleton";
import { Link, replaceUrl } from "../lib/router";
import { Chevron } from "../ui/icons";
import { PackWorkspace } from "./PackWorkspace";

/** 棚の読み込み（一覧と詳しい中身で同じものを使う） */
function usePacks() {
  const [data, setData] = useState<{ categories: string[]; packs: PackView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.packs();
      setData({ categories: r.categories ?? [], packs: r.packs });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const replace = useCallback((next: PackView) => setData((d) => (d === null ? d : { ...d, packs: d.packs.map((x) => (x.id === next.id ? next : x)) })), []);
  return { data, error, load, replace };
}

/** 検索の言葉に当たるか（名前・売り文句・説明・誰向け・担当・スキル・例の依頼のどこかに、空白で区切った言葉がすべて含まれる） */
export function packMatches(p: PackView, q: string): boolean {
  const words = q.toLowerCase().split(/[\s　]+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const hay = [
    p.name,
    p.tagline,
    p.description,
    p.audience,
    p.category ?? "",
    ...p.agents.flatMap((a) => [a.name, a.summary, ...a.files]),
    ...p.skills.flatMap((s) => [s.name, s.description]),
    ...p.examples,
  ]
    .join("\n")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 絞り込みを URL に残す（戻ったときに同じ棚に戻れる。画面は動かさない） */
function keepInUrl(q: string, category: string | null) {
  const qs = new URLSearchParams();
  if (q !== "") qs.set("q", q);
  if (category !== null) qs.set("cat", category);
  const search = qs.toString();
  replaceUrl(search === "" ? "/packs" : `/packs?${search}`);
}

function PageError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="packs-page">
      <h1 className="ask-head">パック</h1>
      <LoadError message={error} onRetry={onRetry} />
    </div>
  );
}

export function Packs({ q: initialQ = "", category: initialCategory = null }: { q?: string; category?: string | null }) {
  const { data, error, load } = usePacks();
  const [q, setQ] = useState(initialQ);
  const [category, setCategory] = useState<string | null>(initialCategory);
  useEffect(() => keepInUrl(q, category), [q, category]);

  const shown = useMemo(() => (data?.packs ?? []).filter((p) => (category === null || p.category === category) && packMatches(p, q)), [data, q, category]);

  if (error && !data) return <PageError error={error} onRetry={() => void load()} />;
  if (!data) return <SkeletonCards count={3} head />;

  return (
    <div className="packs-page">
      <h1 className="ask-head">パック</h1>
      <p className="muted packs-lead">エージェント・手順書・スクリプトの詰め合わせです。入れると、そのまま頼めます。</p>
      <div className="packs-filter">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="さがす（例：採点・請求・SNS）" aria-label="パックをさがす" enterKeyHint="search" />
        {data.categories.length > 0 && (
          <div className="packs-cats" role="group" aria-label="分類">
            {[null, ...data.categories].map((c) => (
              <button key={c ?? "all"} type="button" className="packs-cat" aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c ?? "すべて"}
              </button>
            ))}
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="block card packs-empty">
          <p className="muted">当てはまるパックがありません。</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setQ("");
              setCategory(null);
            }}
          >
            絞り込みを外す
          </button>
        </div>
      ) : (
        <ul className="plain packs-grid" aria-label="パック">
          {shown.map((p) => (
            <PackTile key={p.id} pack={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 棚に並ぶ小さな札（押すとそのパックの作業場） */
function PackTile({ pack: p }: { pack: PackView }) {
  const scripts = p.agents.reduce((n, a) => n + a.files.filter((f) => /\.(py|js|mjs|ts|sh)$/.test(f)).length, 0);
  return (
    <li>
      <Link to={`/packs/${encodeURIComponent(p.id)}`} className="block card pack-tile" aria-label={`${p.name}（${p.audience}向け${p.installedAt !== null ? "・入っています。作業場を見る" : ""}）`}>
        <span className="pack-tile-head">
          <span className="pack-tile-name">{p.name}</span>
          {p.installedAt !== null && <span className="pack-installed">入っています</span>}
        </span>
        <span className="pack-audience">{p.audience}向け</span>
        <span className="pack-tile-tagline">{p.tagline}</span>
        <span className="pack-tile-foot">
          <span className="pack-tile-avatars" aria-hidden="true">
            {p.agents.map((a) => (
              <Avatar key={a.name} name={a.name} mood="idle" size={28} />
            ))}
          </span>
          <span className="row-meta">
            {p.agents.length}人{p.skills.length > 0 && ` · スキル${p.skills.length}`}
            {scripts > 0 && ` · スクリプト${scripts}`}
          </span>
          {p.installedAt !== null && (
            <span className="pack-tile-enter" aria-hidden="true">
              作業場を見る
              <Chevron dir="right" size={14} />
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

/** パックの作業場（`/packs/:packId`） */
export function PackDetail({ packId }: { packId: string }) {
  const { data, error, load, replace } = usePacks();
  if (error && !data) return <PageError error={error} onRetry={() => void load()} />;
  if (!data) return <SkeletonCards count={1} head />;
  const pack = data.packs.find((p) => p.id === packId);
  return (
    <div className="packs-page">
      {/* 棚へ戻るのはヘッダーの「パック」（main.tsx の backOf） */}
      {pack === undefined ? (
        <div className="block card">
          <h1 className="block-title">パックが見つかりません</h1>
          <p className="muted">棚から外れたか、アドレスが違うかもしれません。</p>
        </div>
      ) : (
        <PackWorkspace pack={pack} onInstalled={replace} />
      )}
    </div>
  );
}
