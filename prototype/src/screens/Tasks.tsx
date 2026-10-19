import { useState, type JSX } from 'react'
import { agents, completedDetail, intents, tasks, taskStatusLabel, type Task, type TaskStatus } from '../data'
import { AppHeader } from '../ui/AppHeader'
import type { Decision } from '../ui/ApprovalCard'
import { BackIcon, MenuIcon } from '../ui/icons'
import { Sheet } from '../ui/Sheet'

type Common = { onKill: () => void; killed: boolean; onMenu: () => void }
type Decisions = Record<string, Decision>

const terminal: TaskStatus[] = ['succeeded', 'completed', 'rejected', 'failed', 'cancelled', 'halted']

// モックの状態に、画面で行った操作（承認の判断・キャンセル・Kill Switch）を重ねる
export function effectiveTask(t: Task, decisions: Decisions, cancelled: Set<string>, killed: boolean): Task {
  if (terminal.includes(t.status)) return t
  if (cancelled.has(t.id)) return { ...t, status: 'cancelled' }
  if (killed) return { ...t, status: 'halted', detail: 'kill_switch' }
  const d = t.intentId && decisions[t.intentId]
  if (!d) return t
  if (d !== 'reject') return { ...t, status: 'succeeded' }
  // PR の却下は rejected、MCP の却下は「外部作用なしで完了」（v0.6 の actions_declined）
  const isPr = intents.find((i) => i.id === t.intentId)?.kind === 'open_pr'
  return isPr ? { ...t, status: 'rejected' } : { ...t, status: 'completed', detail: 'actions_declined' }
}

const statusIcon: Record<TaskStatus, string> = {
  queued: '○', running: '●', awaiting_approval: '◐', executing: '●', succeeded: '✓', completed: '✓', rejected: '✕', failed: '✕', cancelled: '■', halted: '■',
}
const statusClass = (s: TaskStatus) =>
  s === 'running' || s === 'executing' || s === 'queued' ? 's-active' : s === 'awaiting_approval' ? 's-pending' : s === 'failed' || s === 'halted' ? 's-disabled' : 's-idle'

function StatusText({ t }: { t: Task }) {
  const label = t.status === 'completed' && t.detail ? `${taskStatusLabel.completed}（${completedDetail[t.detail] ?? t.detail}）` : taskStatusLabel[t.status]
  return <span className={'task-status ' + statusClass(t.status)}>{statusIcon[t.status]} {label}</span>
}

const filters: [string, string, (t: Task) => boolean][] = [
  ['all', 'すべて', () => true],
  ['running', '実行中', (t) => ['queued', 'running', 'executing'].includes(t.status)],
  ['awaiting', '承認待ち', (t) => t.status === 'awaiting_approval'],
  // 「終了」には completed（試し実行・レポート）を含める
  ['done', '終了', (t) => terminal.includes(t.status)],
]

// SCR-004 タスク一覧
export function TaskList({ decisions, cancelled, killed, onKill, onMenu }: Common & { decisions: Decisions; cancelled: Set<string> }) {
  const [filter, setFilter] = useState('all')
  const all = tasks.map((t) => effectiveTask(t, decisions, cancelled, killed))
  const shown = all.filter(filters.find(([k]) => k === filter)![2])
  return (
    <>
      <AppHeader left={<button className="icon-btn" onClick={onMenu} aria-label="メニュー"><MenuIcon /></button>} title={<span className="title-text">タスク</span>} onKill={onKill} killed={killed} />
      <main className="screen">
        <div className="chips filter" role="tablist">
          {filters.map(([k, l, f]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={'chip' + (filter === k ? ' is-on' : '')} onClick={() => setFilter(k)}>
              {l}
              {k !== 'all' && <span className="chip-count">{all.filter(f).length}</span>}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="empty-note muted">該当するタスクはありません</p>
        ) : (
          <ul className="inbox">
            {shown.map((t) => {
              const agent = agents.find((a) => a.id === t.agentId)!
              return (
                <li key={t.id}>
                  <a className="inbox-row" href={`#/tasks/${t.id}`}>
                    <span className="avatar" aria-hidden>{agent.icon}</span>
                    <span className="agent-main">
                      <span className="inbox-title">{t.title}</span>
                      <span className="agent-meta">
                        <StatusText t={t} /> · {agent.name} · {t.trigger}
                      </span>
                      {t.status === 'halted' && t.detail && <span className="small s-disabled">{t.detail}</span>}
                    </span>
                    <span className="muted small inbox-side">{t.updated}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </>
  )
}

// SCR-005 タスク詳細
export function TaskDetail({ id, decisions, cancelled, onCancel, killed, onKill }: Omit<Common, 'onMenu'> & { id: string; decisions: Decisions; cancelled: Set<string>; onCancel: (id: string) => void }) {
  const base = tasks.find((t) => t.id === id)
  const [confirm, setConfirm] = useState(false)
  const back = <a className="icon-btn" href="#/tasks" aria-label="タスクの一覧に戻る"><BackIcon /></a>
  if (!base) {
    return (
      <>
        <AppHeader left={back} title={<span className="title-text">タスク</span>} onKill={onKill} killed={killed} />
        <main className="screen"><p className="empty-note muted">このタスクは見つかりません</p></main>
      </>
    )
  }
  const t = effectiveTask(base, decisions, cancelled, killed)
  const agent = agents.find((a) => a.id === t.agentId)!
  const b = t.budget
  const done = terminal.includes(t.status)

  return (
    <>
      <AppHeader left={back} title={<span className="title-text">{t.title}</span>} onKill={onKill} killed={killed} />
      <main className="screen task-detail">
        <div className="row-between">
          <a className="agent-chip" href={`#/agents/${agent.id}`}>
            <span className="avatar xs" aria-hidden>{agent.icon}</span>
            {agent.name}
          </a>
          <span className="muted small">{t.trigger}</span>
        </div>
        <div className="task-head">
          <StatusText t={t} />
          {t.phase && t.status === 'running' && <code className="muted">{t.phase}</code>}
          {t.tainted && <span className="badge s-pending">汚染あり</span>}
        </div>
        {t.status === 'halted' && t.detail && <p className="small s-disabled">停止の理由：{t.detail === 'kill_switch' ? 'Kill Switch' : t.detail}</p>}

        {t.status === 'awaiting_approval' && t.intentId && (
          <a className="btn btn-primary block" href={`#/approvals/${t.intentId}`}>承認カードを開く</a>
        )}

        <section className="card meters" aria-label="予算">
          <Meter label="費用" v={b.cost} cap={b.costCap} fmt={(n) => `$${n.toFixed(2)}`} />
          <Meter label="ステップ" v={b.steps} cap={b.stepsCap} />
          <Meter label="時間" v={b.min} cap={b.minCap} fmt={(n) => `${n}分`} />
          <Meter label="拒否" v={b.denials} cap={b.denialsCap} />
        </section>

        {t.report && (
          <section className="card report">
            <div className="card-kicker">レポート</div>
            <Markdown src={t.report} />
          </section>
        )}

        <section className="timeline" aria-label="タイムライン">
          <h2 className="section-title">タイムライン</h2>
          <ol>
            {t.timeline.map((e, i) => (
              <li key={i}>
                <span className="tl-time">{e.t}</span>
                <span className="tl-text">
                  {e.text}
                  {e.ai && <span className="ai-tag">AI</span>}
                  {e.ok === true && <span className="add"> ✓</span>}
                  {e.ok === false && <span className="del"> ✕</span>}
                  {e.denied && (
                    <span className="denied">
                      拒否：<code>{e.denied}</code>
                      <span className="rule-chip">ルールによる判定</span>
                    </span>
                  )}
                </span>
              </li>
            ))}
            {t.status === 'cancelled' && <li><span className="tl-time">今</span><span className="tl-text">キャンセルしました</span></li>}
            {t.status === 'halted' && t.detail === 'kill_switch' && <li><span className="tl-time">今</span><span className="tl-text del">Kill Switch で停止しました</span></li>}
          </ol>
        </section>

        <div className="task-actions">
          <button className="btn btn-ghost">この監査ログ</button>
          {!done && <button className="btn" onClick={() => setConfirm(true)}>キャンセル</button>}
        </div>
      </main>

      {confirm && (
        <Sheet title="このタスクをキャンセルしますか？" onClose={() => setConfirm(false)}>
          <p className="small muted">実行中の操作を止め、承認待ちの外部作用も無効にします。元には戻せません。</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setConfirm(false)}>戻る</button>
            <button className="btn btn-danger" onClick={() => { onCancel(t.id); setConfirm(false) }}>キャンセルする</button>
          </div>
        </Sheet>
      )}
    </>
  )
}

function Meter({ label, v, cap, fmt = String }: { label: string; v: number; cap: number; fmt?: (n: number) => string }) {
  const pct = Math.min(100, (v / cap) * 100)
  return (
    <div className="meter">
      <div className="row-between small">
        <span className="label">{label}</span>
        <span>{fmt(v)} / {fmt(cap)}</span>
      </div>
      <div className="bar" role="meter" aria-label={label} aria-valuenow={v} aria-valuemax={cap}>
        <span style={{ width: pct + '%' }} className={pct >= 100 ? 'is-full' : pct >= 75 ? 'is-high' : ''} />
      </div>
    </div>
  )
}

// レポートの簡易 Markdown 表示（見出しと箇条書きだけ）。HTML として解釈しないので、リンクや埋め込みは無害なまま（FR-033）
function Markdown({ src }: { src: string }) {
  const blocks: JSX.Element[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length) blocks.push(<ul key={blocks.length}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>)
    items = []
  }
  for (const line of src.split('\n')) {
    if (line.startsWith('- ')) { items.push(line.slice(2)); continue }
    flush()
    if (line.startsWith('## ')) blocks.push(<h3 key={blocks.length}>{line.slice(3)}</h3>)
    else if (line.trim()) blocks.push(<p key={blocks.length}>{line}</p>)
  }
  flush()
  return <div className="md">{blocks}</div>
}
