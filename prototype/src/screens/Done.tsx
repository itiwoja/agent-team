import { agents } from '../data'
import type { Done as DoneItem } from '../inbox'
import { BackIcon } from '../ui/icons'

// 済んだもの（/done）。チェックした行の履歴。新しい順。
export function Done({ done }: { done: DoneItem[] }) {
  return (
    <>
      <header className="appheader">
        <a className="icon-btn" href="#/" aria-label="戻る"><BackIcon /></a>
        <div className="appheader-title"><span className="brand">済んだもの</span></div>
        <span className="icon-btn" aria-hidden />
      </header>
      <main className="screen ask">
        {done.length === 0 && <p className="muted">まだありません</p>}
        <ul className="rows">
          {done.map((d) => (
            <li key={d.id} className="row done">
              <div className="row-main">
                <div className="row-title">{d.title}</div>
                <div className="row-meta">
                  {agents.find((a) => a.id === d.agentId)?.name ?? '—'} · {d.how} · {d.at}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </>
  )
}
