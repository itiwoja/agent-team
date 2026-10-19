import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { AgentList } from './screens/AgentList'
import { AgentChat } from './screens/AgentChat'
import { Placeholder } from './screens/Placeholder'
import { ApprovalDetail, ApprovalInbox } from './screens/Approvals'
import type { Decision } from './ui/ApprovalCard'
import { intents, tasks } from './data'
import { TaskDetail, TaskList } from './screens/Tasks'
import { Drawer } from './ui/Drawer'
import { KillSwitchSheet } from './ui/KillSwitchSheet'
import { Inbox } from './screens/Inbox'
import { Done } from './screens/Done'
import { initialDone, initialItems, initialRunning, route as routeAsk, type Done as DoneItem, type Item, type Running } from './inbox'

const now = () => new Date().toLocaleTimeString('ja-JP', { hour: 'numeric', minute: '2-digit' })

// ハッシュでルーティング（#/agents, #/agents/news ...）。プロトタイプなのでルーターは入れない。
function useHashRoute() {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

function App() {
  const route = useHashRoute()
  const [killOpen, setKillOpen] = useState(false)
  const [killed, setKilled] = useState(false)
  const [drawer, setDrawer] = useState(false)
  // 承認の判断は画面をまたいで共有する（チャットで承認したらインボックスからも消える）
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const decide = (id: string, d: Decision) => setDecisions((m) => ({ ...m, [id]: d }))
  // キャンセルしたタスクの承認待ちは無効（expired）になり、インボックスから消える
  const [cancelled, setCancelled] = useState<Set<string>>(() => new Set())
  const cancel = (id: string) => setCancelled((s) => new Set(s).add(id))
  const expired = new Set(tasks.filter((t) => cancelled.has(t.id) && t.intentId).map((t) => t.intentId!))
  const pending = intents.filter((i) => !decisions[i.id] && !expired.has(i.id)).length
  // SCR-019 の状態（見てほしいもの・やっていること・済んだもの）
  const [items, setItems] = useState<Item[]>(initialItems)
  const [running, setRunning] = useState<Running[]>(initialRunning)
  const [done, setDone] = useState<DoneItem[]>(initialDone)
  const check = (it: Item, how: string) => {
    setItems((xs) => xs.filter((x) => x.id !== it.id))
    setDone((ds) => [{ id: 'd-' + it.id, agentId: it.agentId, title: it.title, how, at: '今日 ' + now() }, ...ds])
  }
  const answer = (it: Item, a: string) => {
    if (it.id === 'i-q-store') setRunning((rs) => [...rs, { id: 'r-' + it.id, agentId: it.agentId, text: `${a}の在庫を確認しています` }])
  }
  // 頼む → 担当が決まる → 終わったら報告の行が届く（本物は設定プランナーとタスク）
  const ask = (text: string) => {
    const id = 'r-' + Date.now()
    const agentId = routeAsk(text)
    setRunning((rs) => [{ id, text: '受け取りました：' + text }, ...rs])
    setTimeout(() => setRunning((rs) => rs.map((r) => (r.id === id ? { ...r, agentId, text: '「' + text + '」を進めています' } : r))), 1200)
    setTimeout(() => {
      setRunning((rs) => rs.filter((x) => x.id !== id))
      setItems((xs) => [{ kind: 'report', id: 'i-' + id, agentId, title: '「' + text + '」が終わりました', at: now(), body: 'モックの結果です。' }, ...xs])
    }, 7000)
  }
  const stop = (id: string) => setRunning((rs) => rs.filter((r) => r.id !== id))
  const [path, query] = route.split('?')
  const openId = new URLSearchParams(query).get('item') ?? undefined
  const parts = path.split('/').filter(Boolean)
  const common = { onKill: () => setKillOpen(true), killed, onMenu: () => setDrawer(true) }

  let screen
  if (parts.length === 0) {
    screen = <Inbox items={items} running={running} openId={openId} killed={killed} onKill={common.onKill} onMenu={common.onMenu} onCheck={check} onDecide={decide} onAnswer={answer} onAsk={ask} onStop={stop} />
  } else if (parts[0] === 'done') {
    screen = <Done done={done} />
  } else if (parts[0] === 'agents' && parts[1]) {
    screen = <AgentChat agentId={parts[1]} decisions={decisions} onDecide={decide} {...common} />
  } else if (parts[0] === 'agents') {
    screen = <AgentList {...common} />
  } else if (parts[0] === 'approvals' && parts[1]) {
    screen = <ApprovalDetail id={parts[1]} decisions={decisions} expired={expired} onDecide={decide} onKill={common.onKill} killed={killed} />
  } else if (parts[0] === 'approvals') {
    screen = <ApprovalInbox decisions={decisions} expired={expired} {...common} />
  } else if (parts[0] === 'tasks' && parts[1]) {
    screen = <TaskDetail id={parts[1]} decisions={decisions} cancelled={cancelled} onCancel={cancel} onKill={common.onKill} killed={killed} />
  } else if (parts[0] === 'tasks') {
    screen = <TaskList decisions={decisions} cancelled={cancelled} {...common} />
  } else {
    const titles: Record<string, string> = { home: 'ホーム', more: 'ルールと設定', audit: '記録' }
    screen = <Placeholder title={titles[parts[0]] ?? parts[0]} {...common} />
  }

  return (
    <div className="app">
      {screen}
      {drawer && <Drawer current={parts.join('/')} pending={items.length} onClose={() => setDrawer(false)} />}
      {killOpen && (
        <KillSwitchSheet
          killed={killed}
          onClose={() => setKillOpen(false)}
          onConfirm={() => {
            setKilled(!killed)
            setKillOpen(false)
          }}
        />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
