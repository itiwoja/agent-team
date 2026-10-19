import { useState } from 'react'
import { agents, riskLabel, type Intent, type McpIntent, type PrIntent } from '../data'
import { Sheet } from './Sheet'

export type Decision = 'approve' | 'always' | 'reject'

const decidedText: Record<Decision, string> = { approve: '✓ 承認しました', always: '✓ 承認・以後も許可しました', reject: '✕ やめました' }

// SCR-007 承認カード。チャットの中（compact）と承認画面の両方で使う。
export function ApprovalCard({ intent, decided, onDecide, compact }: { intent: Intent; decided?: Decision; onDecide: (d: Decision) => void; compact?: boolean }) {
  const [sheet, setSheet] = useState<'always' | 'approve' | 'reject' | null>(null)
  const isPr = intent.kind === 'open_pr'
  const finish = (d: Decision) => {
    setSheet(null)
    onDecide(d)
  }

  return (
    <section className={'card card-approval' + (decided ? ' is-decided' : '')} aria-label="承認カード">
      <div className="card-kicker row">
        <span className="badge s-pending">承認待ち</span>
        <span className={'small' + (intent.expiringSoon ? ' s-pending' : ' muted')}>残り {intent.expiresIn}</span>
      </div>
      {intent.kind === 'mcp_call' ? <McpBody a={intent} compact={compact} /> : <PrBody a={intent} />}
      {decided ? (
        <div className={'decided' + (decided === 'reject' ? ' is-reject' : '')}>{decidedText[decided]}</div>
      ) : isPr ? (
        <div className="approval-actions two">
          <button className="btn" onClick={() => setSheet('reject')}>却下</button>
          <button className="btn btn-primary" onClick={() => setSheet('approve')}>承認</button>
        </div>
      ) : (
        <div className={'approval-actions' + (intent.canAllowAlways ? '' : ' two')}>
          <button className="btn" onClick={() => onDecide('reject')}>やめる</button>
          {intent.canAllowAlways && <button className="btn" onClick={() => setSheet('always')}>以後も許可</button>}
          <button className="btn btn-primary" onClick={() => onDecide('approve')}>承認</button>
        </div>
      )}

      {sheet === 'always' && intent.kind === 'mcp_call' && <AllowAlwaysSheet a={intent} onClose={() => setSheet(null)} onConfirm={() => finish('always')} />}
      {sheet === 'approve' && (
        // PR は intentHash の先頭8文字を見せてから確定（ADR-005）
        <Sheet title="このPRを作成します" onClose={() => setSheet(null)}>
          <p className="small muted">承認は、いま表示している内容（intentHash）に結びつきます。内容が変わっていたら実行されません。</p>
          <div className="kv-block fixed">
            <div className="kv-head">intentHash</div>
            <code className="hash">{intent.hash.slice(0, 8)}</code>
          </div>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setSheet(null)}>戻る</button>
            <button className="btn btn-primary" onClick={() => finish('approve')}>承認する</button>
          </div>
        </Sheet>
      )}
      {sheet === 'reject' && <RejectSheet onClose={() => setSheet(null)} onConfirm={() => finish('reject')} />}
    </section>
  )
}

function Risk({ a }: { a: Intent }) {
  return (
    <div className="risk">
      <div className="row-between">
        <span>
          <span className="label">リスク</span> <b className={'risk-' + a.risk}>{riskLabel[a.risk]}</b>
        </span>
        <span className="rule-chip">ルールによる判定</span>
      </div>
      <ul>{a.riskReasons.map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  )
}

export function McpBody({ a, compact }: { a: McpIntent; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="dest">
        <div className="label">宛先</div>
        <div className="dest-main">{a.service} · {a.destination.label}</div>
        <code className="dest-raw">{a.destination.raw}</code>
      </div>
      <div className="content-block">
        <div className="label">中身</div>
        <pre className={'content' + (open ? ' open' : '')}>{a.content}</pre>
        <button className="link" onClick={() => setOpen(!open)}>{open ? '閉じる' : 'すべて見る'}</button>
      </div>
      {!compact && <Risk a={a} />}
      {!compact && a.taintedBy && (
        <div className="taint">
          <div className="label">このタスクが読んだ情報源（汚染）</div>
          <div className="taint-list">{a.taintedBy.map((t) => <span key={t} className="taint-chip">{t}</span>)}</div>
        </div>
      )}
      <div className="meta-rows">
        <div><span className="label">その他</span> {a.options.map((o) => `${o.k}: ${o.v}`).join(', ')}</div>
        <div><span className="label">ツール</span> <code>{a.tool}</code>{!compact && <span className="muted"> · {a.server}</span>}</div>
        <div className="rule"><span className="rule-chip">ルールによる判定</span> <code>{a.rule}</code></div>
      </div>
    </>
  )
}

export function PrBody({ a }: { a: PrIntent }) {
  const [showAll, setShowAll] = useState(false)
  const add = a.files.reduce((n, f) => n + f.add, 0)
  const del = a.files.reduce((n, f) => n + f.del, 0)
  const files = showAll ? a.files : a.files.slice(0, 2)
  return (
    <>
      <div className="dest">
        <div className="label">{a.repo} #{a.issue}</div>
        <div className="dest-main">PR: {a.title}</div>
        <code className="dest-raw">{a.base} ← {a.head}</code>
      </div>
      <Risk a={a} />
      <div className="ai-block">
        <div className="label">AIによる要約（参考）</div>
        <p>{a.summary}</p>
      </div>
      <div className="ai-block">
        <div className="label">AIによる自己レビュー（参考）</div>
        <p>{a.selfReview.result}（修正 {a.selfReview.fixes}回）· 未解決の指摘 {a.selfReview.open}</p>
      </div>
      <div className="files">
        <div className="row-between">
          <span className="label">変更 {a.files.length} files</span>
          <span className="small"><span className="add">+{add}</span> / <span className="del">−{del}</span></span>
        </div>
        <ul>
          {files.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code>
              <span className="small"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
            </li>
          ))}
        </ul>
        {a.files.length > 2 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? '閉じる' : `ほか ${a.files.length - 2} files`}</button>}
      </div>
      <div className="meta-rows">
        <div>
          <span className="label">テスト（エージェントの自己申告）</span>{' '}
          {a.tests.map((t) => <span key={t.cmd}><code>{t.cmd}</code> {t.ok ? <span className="add">✓ passed</span> : <span className="del">✕ failed</span>}</span>)}
        </div>
        <div><span className="label">コスト</span> ${a.cost.used.toFixed(2)} / ${a.cost.cap.toFixed(2)} · steps {a.cost.steps}</div>
        <div className="rule"><span className="rule-chip">実効ポリシー</span> <code>{a.rule}</code> <span className="muted">· {a.policy}</span></div>
      </div>
    </>
  )
}

export function AllowAlwaysSheet({ a, onClose, onConfirm }: { a: McpIntent; onClose: () => void; onConfirm: () => void }) {
  return (
    <Sheet title="以後も許可しますか？" onClose={onClose}>
      <p className="small muted">次の値が同じなら、今後は承認なしで実行します。</p>
      <div className="kv-block fixed">
        <div className="kv-head">🔒 固定される値</div>
        <ul>{a.fixed.map((f) => <li key={f}>{f}</li>)}</ul>
      </div>
      <div className="kv-block variable">
        <div className="kv-head">毎回変わってよい値</div>
        <ul>{a.variable.map((f) => <li key={f}>{f}</li>)}</ul>
      </div>
      <p className="small muted">ルールは「ワークスペース › ルール」からいつでも外せます。</p>
      <div className="sheet-actions">
        <button className="btn" onClick={onClose}>やめる</button>
        <button className="btn btn-primary" onClick={onConfirm}>以後も許可</button>
      </div>
    </Sheet>
  )
}

function RejectSheet({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const [comment, setComment] = useState('')
  return (
    <Sheet title="却下しますか？" onClose={onClose}>
      <label className="field">
        コメント（任意・エージェントには渡しません）
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="却下の理由" />
      </label>
      <div className="sheet-actions">
        <button className="btn" onClick={onClose}>戻る</button>
        <button className="btn btn-danger" onClick={onConfirm}>却下する</button>
      </div>
    </Sheet>
  )
}

export const agentOf = (i: Intent) => agents.find((a) => a.id === i.agentId) ?? agents[0]
