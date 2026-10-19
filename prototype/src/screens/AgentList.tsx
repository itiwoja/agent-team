import { useState } from 'react'
import { agents, statusLabel } from '../data'
import { AppHeader } from '../ui/AppHeader'
import { Composer } from '../ui/Composer'
import { ChevronDownIcon, MenuIcon, NewIcon } from '../ui/icons'

// SCR-014 エージェント一覧（v0.5：名前だけで作る）。ChatGPT のホームのように、入力欄から始める。
export function AgentList({ onKill, killed, onMenu }: { onKill: () => void; killed: boolean; onMenu: () => void }) {
  const [name, setName] = useState('')
  const create = () => (location.hash = '#/agents/news')

  return (
    <>
      <AppHeader
        left={<button className="icon-btn" onClick={onMenu} aria-label="メニュー"><MenuIcon /></button>}
        title={<button className="title-btn">open-team <ChevronDownIcon /></button>}
        right={<button className="icon-btn" onClick={create} aria-label="新しいエージェント"><NewIcon /></button>}
        onKill={onKill}
        killed={killed}
      />
      <main className="screen home">
        <h1 className="hero">何を任せますか？</h1>
        <p className="hero-sub">名前をつけるだけで、エージェントが聞きに来ます。</p>

        <div className="section-head">
          <h2>エージェント</h2>
          <span className="muted small">{agents.length} / 20</span>
        </div>
        <ul className="agent-list">
          {agents.map((a) => (
            <li key={a.id}>
              <a className="agent-row" href={`#/agents/${a.id}`}>
                <span className="avatar" aria-hidden>{a.icon}</span>
                <span className="agent-main">
                  <span className="agent-name">
                    {a.name}
                    {a.repo && <span className="repo">{a.repo}</span>}
                  </span>
                  <span className="agent-meta">
                    {a.note ? <span className={'s-' + a.status}>{a.note}</span> : <>仕事 {a.jobs}{a.nextRun && <> · 次回 {a.nextRun}</>}</>}
                  </span>
                </span>
                <span className={'badge s-' + a.status}>{statusLabel[a.status]}</span>
              </a>
            </li>
          ))}
        </ul>
      </main>
      <div className="dock">
        <div className="suggest">
          {[
            ['ニュースリサーチャー', '毎朝ニュースをまとめる'],
            ['ページ監視係', 'ページが変わったら知らせる'],
            ['経費アシスタント', 'レシートを表にする'],
          ].map(([n, d]) => (
            <button key={n} className="suggest-card" onClick={() => setName(n)}>
              <b>{n}</b>
              <span>{d}</span>
            </button>
          ))}
        </div>
        <Composer value={name} onChange={setName} onSend={create} placeholder="新しいエージェントに名前をつける" />
      </div>
    </>
  )
}
