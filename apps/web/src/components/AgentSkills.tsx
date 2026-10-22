// 担当のカードの「スキル」のまとまり：使えるスキル（パック／育った）・スキルの案（○ 使う／× 要らない）・外したもの（戻す）。
// スキル＝手順書。案は人が ○ を押すまで担当のスキルにならない。操作は owner・maintainer だけ
import { useState } from "react";
import { api, describeError, type AgentLibraryItem } from "../api";
import { formatTime } from "../lib/format";
import { useWorkspace } from "../workspace";
import { Markdown } from "./Markdown";

/** スキルの案・外したもの・スキルがあるか（なければこの区画は出さない） */
export function hasSkillSection(a: Pick<AgentLibraryItem, "skills" | "skillProposals" | "pruned">): boolean {
  return (a.skills?.length ?? 0) + (a.skillProposals?.length ?? 0) + (a.pruned?.length ?? 0) > 0;
}

/** 戻していない外したものの数（カードの見出しの一言に使う） */
export function restorableCount(a: Pick<AgentLibraryItem, "pruned">): number {
  return (a.pruned ?? []).reduce((n, e) => n + e.items.filter((i) => !i.restoredAt).length, 0);
}

export function AgentSkills({ agent: a, onChanged }: { agent: AgentLibraryItem; onChanged: () => void }) {
  const { workspace } = useWorkspace();
  const canEdit = workspace.role === "owner" || workspace.role === "maintainer";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 二重押しを防ぎ（busy のあいだは何も受けない）、失敗は画面に出し、成功したら一覧を取り直す
  const run = (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    fn()
      .then(() => onChanged())
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(null));
  };

  const skills = a.skills ?? [];
  const proposals = a.skillProposals ?? [];
  // 戻したものはスキルの一覧に戻るので、外したものには戻していないものだけを出す（同じものを2か所に出さない）
  const pruned = (a.pruned ?? []).map((e) => ({ ...e, items: e.items.filter((i) => !i.restoredAt) })).filter((e) => e.items.length > 0);
  if (!hasSkillSection(a)) return null;

  return (
    <section className="agent-skills">
      <h2 className="agent-sub">スキル（手順書）</h2>

      {proposals.length > 0 && (
        <div className="skill-block">
          <h3 className="skill-sub">スキルの案</h3>
          <ul className="plain skill-list">
            {proposals.map((p) => (
              <li key={p.id} className="skill-proposal">
                <div className="skill-name">{p.name}</div>
                <div className="muted small">{p.description}</div>
                {p.reason && <div className="muted small">{p.reason}</div>}
                <details className="skill-body">
                  <summary>手順を読む</summary>
                  <Markdown text={p.body} />
                </details>
                {canEdit ? (
                  <div className="inline-actions">
                    <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => run(`p:${p.id}`, () => api.decideSkillProposal(a.id, p.id, "approve"))}>
                      {busy === `p:${p.id}` ? "…" : "○ 使う"}
                    </button>
                    <button type="button" className="btn" disabled={busy !== null} onClick={() => run(`p:${p.id}`, () => api.decideSkillProposal(a.id, p.id, "reject"))}>
                      × 要らない
                    </button>
                  </div>
                ) : (
                  <p className="muted small">使うかどうかは、オーナーかメンテナーが決めます</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {skills.length > 0 && (
        <div className="skill-block">
          <ul className="plain skill-list">
            {skills.map((s) => (
              <li key={s.id} className="skill-item">
                <div className="skill-head">
                  <span className="skill-name">{s.name}</span>
                  <span className="agent-role">{s.origin === "learned" ? "育ったスキル" : "パックのスキル"}</span>
                </div>
                <div className="muted small">{s.description}</div>
                <div className="muted small">{s.lastUsedAt ? `最後に使った ${formatTime(s.lastUsedAt)}` : "まだ使われていません"}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pruned.length > 0 && (
        <div className="skill-block">
          <h3 className="skill-sub">しばらく使われていないので外しました</h3>
          <ul className="plain skill-list">
            {pruned.map((e) =>
              e.items.map((i) => (
                <li key={`${e.eventId}:${i.type}:${i.id}`} className="skill-item skill-pruned">
                  <div className="skill-head">
                    <span className="skill-name">{i.label}</span>
                    <span className="agent-role">{i.type === "skill" ? "スキル" : "ルール"}</span>
                  </div>
                  <div className="muted small">{formatTime(e.createdAt)} に外しました</div>
                  {canEdit ? (
                    <div className="inline-actions">
                      <button type="button" className="btn" disabled={busy !== null} onClick={() => run(`r:${e.eventId}:${i.id}`, () => api.restoreEvolution(a.id, e.eventId, i.type, i.id))}>
                        {busy === `r:${e.eventId}:${i.id}` ? "戻しています…" : "戻す"}
                      </button>
                    </div>
                  ) : null}
                </li>
              )),
            )}
          </ul>
        </div>
      )}

      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
