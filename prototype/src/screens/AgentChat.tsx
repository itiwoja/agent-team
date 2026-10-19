import { useEffect, useRef, useState } from 'react'
import { agents, intents, newsChat, statusLabel, type Agent, type Msg } from '../data'
import { ApprovalCard, type Decision } from '../ui/ApprovalCard'
import { AppHeader } from '../ui/AppHeader'
import { Composer } from '../ui/Composer'
import { ChevronDownIcon, MenuIcon } from '../ui/icons'
import { Sheet } from '../ui/Sheet'
import { AgentJobs } from './AgentJobs'

// SCR-017 エージェント詳細＋ SCR-018 チャット（既定）。ほかのタブはタイトルのメニューから開く
export function AgentChat({ agentId, decisions, onDecide, onKill, killed, onMenu }: {
  agentId: string
  decisions: Record<string, Decision>
  onDecide: (id: string, d: Decision) => void
  onKill: () => void
  killed: boolean
  onMenu: () => void
}) {
  const agent = agents.find((a) => a.id === agentId) ?? agents[0]
  const [tab, setTab] = useState('chat')
  const [msgs, setMsgs] = useState<Msg[]>(newsChat)
  const [text, setText] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  // 開いたとき・発言が増えたときは最新のカードまで送る。
  // チャットは自分の中でスクロールさせる（window だとハッシュ遷移でブラウザに先頭へ戻される）
  const chatRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, tab])

  const decide = (id: string, d: Decision) => {
    onDecide(id, d)
    if (d === 'always') setMsgs((m) => [...m, { kind: 'agent', text: '明日から毎朝 7:00 に自動で送ります。' }])
  }

  const send = () => {
    if (!text.trim()) return
    setMsgs((m) => [...m, { kind: 'user', text }])
    setText('')
  }

  const tabs = [['chat', 'チャット'], ['jobs', '仕事'], ['history', '変更履歴'], ['advanced', '詳細設定']]

  return (
    <>
      <AppHeader
        left={<button className="icon-btn" onClick={onMenu} aria-label="メニュー"><MenuIcon /></button>}
        title={
          <button className="title-btn" onClick={() => setMenuOpen(true)} aria-label="エージェントのメニュー">
            <span className="chat-name">{agent.name}</span>
            <span className={'dot s-' + agent.status} title={statusLabel[agent.status]} />
            <ChevronDownIcon />
          </button>
        }
        onKill={onKill}
        killed={killed}
      />

      {tab === 'jobs' ? (
        <AgentJobs key={agent.id} agentId={agent.id} agentName={agent.name} onBack={() => setTab('chat')} />
      ) : tab !== 'chat' ? (
        <main className="screen empty">
          <div className="center-stack">
            <p className="muted">「{tabs.find(([k]) => k === tab)?.[1]}」はまだ作っていません（Q-53）。</p>
            <button className="btn" onClick={() => setTab('chat')}>チャットに戻る</button>
          </div>
        </main>
      ) : (
        <>
          <main className="screen chat" ref={chatRef}>
            {msgs.map((m, i) => (
              <Message key={i} m={m} agent={agent} decisions={decisions} onDecide={decide} />
            ))}
          </main>
          <div className="dock">
            {msgs.length <= 1 && (
              <div className="chips">
                <button className="chip" onClick={() => setText('毎朝ニュースをまとめて')}>毎朝ニュースをまとめて</button>
                <button className="chip" onClick={() => setText('このページが変わったら教えて')}>このページが変わったら教えて</button>
              </div>
            )}
            <Composer value={text} onChange={setText} onSend={send} placeholder={`${agent.name}に頼む`} />
          </div>
        </>
      )}

      {menuOpen && (
        <Sheet title={agent.name} onClose={() => setMenuOpen(false)}>
          <p className={'small s-' + agent.status}>● {statusLabel[agent.status]}</p>
          <div className="menu-list">
            {tabs.map(([k, l]) => (
              <button key={k} className={'menu-item' + (tab === k ? ' is-current' : '')} onClick={() => { setTab(k); setMenuOpen(false) }}>
                {l}
              </button>
            ))}
          </div>
        </Sheet>
      )}

    </>
  )
}

function Message({ m, agent, decisions, onDecide }: { m: Msg; agent: Agent; decisions: Record<string, Decision>; onDecide: (id: string, d: Decision) => void }) {
  switch (m.kind) {
    case 'user':
      return <div className="bubble user">{m.text}</div>
    case 'agent':
      return (
        <div className="msg-agent">
          <span className="avatar xs" aria-hidden>{agent.icon}</span>
          <p>{m.text}</p>
        </div>
      )
    case 'plan':
      return (
        <section className="card">
          <div className="card-kicker">こうします</div>
          <ul className="plan">{m.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <div className="card-actions"><button className="btn btn-ghost">変える</button></div>
        </section>
      )
    case 'connect':
      return (
        <section className="card card-connect">
          <div className="card-kicker">接続</div>
          <p>{m.service} がまだつながっていません</p>
          <div className="card-actions"><button className="btn">✓ {m.service} をつないだ</button></div>
        </section>
      )
    case 'approval': {
      const intent = intents.find((i) => i.id === m.id)
      return intent ? <ApprovalCard intent={intent} decided={decisions[m.id]} onDecide={(d) => onDecide(m.id, d)} compact /> : null
    }
    default:
      return null
  }
}
