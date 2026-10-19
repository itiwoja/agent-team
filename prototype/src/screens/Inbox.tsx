import { useEffect, useState } from 'react'
import { agents, intents, type McpIntent } from '../data'
import type { Item, Running } from '../inbox'
import { AllowAlwaysSheet, McpBody, PrBody, type Decision } from '../ui/ApprovalCard'
import { Composer } from '../ui/Composer'
import { MenuIcon } from '../ui/icons'
import { Sheet } from '../ui/Sheet'

const UNDO_SECONDS = 5 // A-91
const order: Record<Item['kind'], number> = { send: 0, widen: 0, question: 1, report: 2 } // A-92

const agentName = (id?: string) => agents.find((a) => a.id === id)?.name ?? '振り分け中…'

// SCR-019 頼む・チェック。することは「頼む」と「チェックする」の2つだけ。
export function Inbox(props: {
  items: Item[]
  running: Running[]
  openId?: string
  killed: boolean
  onKill: () => void
  onMenu: () => void
  onCheck: (item: Item, how: string) => void
  onDecide: (intentId: string, d: Decision) => void
  onAnswer: (item: Item, answer: string) => void
  onAsk: (text: string) => void
  onStop: (id: string) => void
}) {
  const { items, running, killed } = props
  const [text, setText] = useState('')
  const [open, setOpen] = useState<string | undefined>(props.openId)
  const [runOpen, setRunOpen] = useState(false)
  const [stopping, setStopping] = useState<Running | null>(null)
  const sorted = [...items].sort((a, b) => order[a.kind] - order[b.kind])

  const ask = () => {
    if (!text.trim() || killed) return
    props.onAsk(text.trim())
    setText('')
  }

  return (
    <>
      <header className="appheader">
        <button className="icon-btn" onClick={props.onMenu} aria-label="メニュー"><MenuIcon /></button>
        <div className="appheader-title"><span className="brand">open-team</span></div>
        <button className={'stop-text' + (killed ? ' is-killed' : '')} onClick={props.onKill}>
          {killed ? '止めています' : '全部止める'}
        </button>
      </header>
      {killed && <div className="banner banner-danger" role="status">すべて止めています。解除するまで新しく頼めません。</div>}

      <main className="screen ask">
        <h1 className="ask-head">
          {items.length ? <>見てほしいもの <span className="ask-count">{items.length}</span></> : <span className="muted">見てほしいものはありません</span>}
        </h1>

        <ul className="rows">
          {sorted.map((it) => (
            <Row
              key={it.id}
              item={it}
              open={open === it.id}
              killed={killed}
              onToggle={() => setOpen(open === it.id ? undefined : it.id)}
              onCheck={props.onCheck}
              onDecide={props.onDecide}
              onAnswer={props.onAnswer}
            />
          ))}
        </ul>

        {running.length > 0 && (
          <section className="running">
            <button className="running-toggle" onClick={() => setRunOpen(!runOpen)} aria-expanded={runOpen}>
              やっていること {running.length}
              <span aria-hidden>{runOpen ? '︿' : '＞'}</span>
            </button>
            {runOpen && (
              <ul className="running-list">
                {running.map((r) => (
                  <li key={r.id}>
                    <span>
                      <span className="who">{agentName(r.agentId)}</span> · {killed ? '止めています' : r.text}
                    </span>
                    {!killed && <button className="link quiet" onClick={() => setStopping(r)}>やめる</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <a className="done-link" href="#/done">済んだもの</a>
      </main>

      <div className="dock">
        <Composer value={text} onChange={setText} onSend={ask} placeholder={killed ? '止めている間は頼めません' : '何をしてほしい？'} />
      </div>

      {stopping && (
        <Sheet title="この仕事をやめますか？" onClose={() => setStopping(null)}>
          <p>{agentName(stopping.agentId)} · {stopping.text}</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setStopping(null)}>続ける</button>
            <button className="btn btn-danger" onClick={() => { props.onStop(stopping.id); setStopping(null) }}>やめる</button>
          </div>
        </Sheet>
      )}
    </>
  )
}

function Row({ item, open, killed, onToggle, onCheck, onDecide, onAnswer }: {
  item: Item
  open: boolean
  killed: boolean
  onToggle: () => void
  onCheck: (item: Item, how: string) => void
  onDecide: (intentId: string, d: Decision) => void
  onAnswer: (item: Item, answer: string) => void
}) {
  // 送る前の確認は、押してから UNDO_SECONDS 秒だけ取り消せる。過ぎてから承認を送る（D-43）
  const [left, setLeft] = useState<number | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [always, setAlways] = useState(false)
  const [free, setFree] = useState(false)
  const [freeText, setFreeText] = useState('')
  const intent = item.kind === 'send' ? intents.find((i) => i.id === item.intentId) : undefined

  const finish = (how: string, after?: () => void) => {
    setLeaving(true)
    setTimeout(() => {
      after?.()
      onCheck(item, how)
    }, 220)
  }

  useEffect(() => {
    if (left === null) return
    if (left === 0) {
      finish(item.kind === 'widen' ? '許可した' : '送った', () => intent && onDecide(intent.id, 'approve'))
      return
    }
    const t = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  // Kill Switch が入ったら、猶予中のものも送らない
  useEffect(() => {
    if (killed) setLeft(null)
  }, [killed])

  const isGate = item.kind === 'send' || item.kind === 'widen'
  const pressCheck = () => (isGate ? setLeft(UNDO_SECONDS) : finish('見た'))

  if (left !== null && left > 0) {
    return (
      <li className="row is-pending">
        <div className="row-main">
          <div className="row-title">{item.title}</div>
          <div className="undo" role="status">
            <span>{item.kind === 'widen' ? '許可します…' : '送ります…'}</span>
            <button className="undo-btn" onClick={() => setLeft(null)}>取り消す <span className="undo-sec">{left}</span></button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <li className={'row' + (leaving ? ' is-leaving' : '') + (open ? ' is-open' : '')}>
      <div className="row-top">
        <button className="row-main" onClick={onToggle} aria-expanded={open}>
          <div className={'row-title' + (item.kind === 'report' && item.failed ? ' failed' : '')}>
            {item.kind === 'report' && item.failed && '失敗：'}
            {item.title}
          </div>
          {item.kind === 'send' && intent && (
            <div className="row-dest">
              → {intent.kind === 'mcp_call' ? `${intent.service} · ${intent.destination.label}` : `${intent.repo} · ${intent.base} へ`}
            </div>
          )}
          {item.kind === 'widen' && <div className="row-dest">できることが増えます：{item.gain}</div>}
          <div className="row-meta">{agentName(item.agentId)} · {item.at}</div>
        </button>
        {item.kind !== 'question' && (
          <button
            className={'check' + (isGate ? ' gate' : '')}
            onClick={pressCheck}
            disabled={killed && isGate}
            aria-label={item.kind === 'send' ? '送ってよい' : item.kind === 'widen' ? '許可する' : 'チェック'}
          >
            <span className="check-ring" aria-hidden />
            {isGate && <span className="check-label">{item.kind === 'send' ? '送る' : '許可'}</span>}
          </button>
        )}
      </div>

      {item.kind === 'question' && (
        <div className="choices">
          {item.choices.map((c) => (
            <button key={c} className="choice" onClick={() => finish(`「${c}」と答えた`, () => onAnswer(item, c))}>{c}</button>
          ))}
          {item.free && !free && <button className="link quiet" onClick={() => setFree(true)}>自分で書く</button>}
        </div>
      )}
      {free && item.kind === 'question' && (
        <div className="free">
          <input value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder="答えを書く" autoFocus />
          <button className="btn btn-primary" disabled={!freeText.trim()} onClick={() => finish(`「${freeText}」と答えた`, () => onAnswer(item, freeText))}>答える</button>
        </div>
      )}

      {open && (
        <div className="row-detail">
          {item.kind === 'report' && <ReportDetail item={item} />}
          {item.kind === 'question' && <p className="muted">{item.why}</p>}
          {item.kind === 'widen' && (
            <>
              <p>{item.why}</p>
              <p className="small muted"><span className="rule-chip">ルールによる判定</span> 権限を広げる変更（widen）なので、許可するまで使えません。</p>
              <button className="link quiet" onClick={() => finish('許可しなかった')}>許可しない</button>
            </>
          )}
          {item.kind === 'send' && intent && (
            <>
              {intent.kind === 'mcp_call' ? <McpBody a={intent} /> : <PrBody a={intent} />}
              <div className="detail-actions">
                <button className="link quiet" onClick={() => finish('送らなかった', () => onDecide(intent.id, 'reject'))}>送らない</button>
                {intent.kind === 'mcp_call' && intent.canAllowAlways && !killed && (
                  <button className="link quiet" onClick={() => setAlways(true)}>次からは聞かずに送る</button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {always && intent && (
        <AllowAlwaysSheet
          a={intent as McpIntent}
          onClose={() => setAlways(false)}
          onConfirm={() => {
            setAlways(false)
            finish('送った・次からは聞かずに送る', () => onDecide(intent.id, 'always'))
          }}
        />
      )}
    </li>
  )
}

function ReportDetail({ item }: { item: Extract<Item, { kind: 'report' }> }) {
  const r = item.rehearsal
  return (
    <>
      {r && (
        <div className="steps" aria-label="練習の結果">
          <div><b>{r.none}</b><span>統制なしなら<br />実害</span></div>
          <div><b>{r.governed}</b><span>統制あり<br />すり抜け</span></div>
          <div className="good"><b>{r.tightened}</b><span>締めたあと<br />すり抜け</span></div>
        </div>
      )}
      {item.body && <p className="report-body">{item.body}</p>}
      <a className="link quiet" href={`#/agents/${item.agentId}`}>{agentName(item.agentId)}のページ</a>
    </>
  )
}
