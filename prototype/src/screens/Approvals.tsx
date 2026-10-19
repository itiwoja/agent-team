import { intents, riskLabel, type Intent } from '../data'
import { AppHeader } from '../ui/AppHeader'
import { agentOf, ApprovalCard, type Decision } from '../ui/ApprovalCard'
import { BackIcon, MenuIcon } from '../ui/icons'

type Common = { onKill: () => void; killed: boolean; onMenu: () => void }
type Decisions = Record<string, Decision>

// SCR-006 承認インボックス。MCP の行は宛先を、PR の行はリポジトリと変更の規模を見せる（Q-56 の仮置き）
export function ApprovalInbox({ decisions, expired, onKill, killed, onMenu }: Common & { decisions: Decisions; expired: Set<string> }) {
  const live = intents.filter((i) => !expired.has(i.id))
  const pending = live.filter((i) => !decisions[i.id])
  const done = live.filter((i) => decisions[i.id])
  return (
    <>
      <AppHeader left={<button className="icon-btn" onClick={onMenu} aria-label="メニュー"><MenuIcon /></button>} title={<span className="title-text">承認</span>} onKill={onKill} killed={killed} />
      <main className="screen">
        <div className="section-head">
          <h2>承認待ち</h2>
          <span className="muted small">{pending.length} 件</span>
        </div>
        {pending.length === 0 ? (
          <p className="empty-note muted">承認待ちはありません</p>
        ) : (
          <ul className="inbox">{pending.map((i) => <InboxRow key={i.id} i={i} />)}</ul>
        )}
        {done.length > 0 && (
          <>
            <div className="section-head spaced">
              <h2>判断済み</h2>
            </div>
            <ul className="inbox">{done.map((i) => <InboxRow key={i.id} i={i} decision={decisions[i.id]} />)}</ul>
          </>
        )}
      </main>
    </>
  )
}

function InboxRow({ i, decision }: { i: Intent; decision?: Decision }) {
  const agent = agentOf(i)
  return (
    <li>
      <a className={'inbox-row' + (decision ? ' is-done' : '')} href={`#/approvals/${i.id}`}>
        <span className="avatar" aria-hidden>{agent.icon}</span>
        <span className="agent-main">
          <span className="inbox-title">
            {i.kind === 'mcp_call' ? <>{i.service} · {i.destination.label}</> : <>{i.repo} #{i.issue}</>}
          </span>
          <span className="agent-meta">
            {agent.name} ·{' '}
            {i.kind === 'mcp_call'
              ? <code>{i.tool}</code>
              : <>{i.files.length} files +{i.files.reduce((n, f) => n + f.add, 0)}/−{i.files.reduce((n, f) => n + f.del, 0)} · ${i.cost.used.toFixed(2)}</>}
          </span>
        </span>
        <span className="inbox-side">
          {decision ? (
            <span className={'badge ' + (decision === 'reject' ? 's-disabled' : 's-active')}>{decision === 'reject' ? 'やめた' : '承認済み'}</span>
          ) : (
            <>
              <span className={'risk-' + i.risk + ' small strong'}>{riskLabel[i.risk]}</span>
              <span className={'small' + (i.expiringSoon ? ' s-pending strong' : ' muted')}>残り{i.expiresIn}</span>
            </>
          )}
        </span>
      </a>
    </li>
  )
}

// SCR-007 承認カード（単独の画面）
export function ApprovalDetail({ id, decisions, expired, onDecide, onKill, killed }: Omit<Common, 'onMenu'> & { id: string; decisions: Decisions; expired: Set<string>; onDecide: (id: string, d: Decision) => void }) {
  const intent = intents.find((i) => i.id === id)
  const agent = intent && agentOf(intent)
  return (
    <>
      <AppHeader
        left={<a className="icon-btn" href="#/approvals" aria-label="承認の一覧に戻る"><BackIcon /></a>}
        title={<span className="title-text">{intent ? (intent.kind === 'open_pr' ? `${intent.repo} #${intent.issue}` : intent.service) : '承認'}</span>}
        onKill={onKill}
        killed={killed}
      />
      <main className="screen">
        {!intent || !agent ? (
          <p className="empty-note muted">この承認は見つかりません</p>
        ) : (
          <>
            <a className="agent-chip" href={`#/agents/${agent.id}`}>
              <span className="avatar xs" aria-hidden>{agent.icon}</span>
              {agent.name}
            </a>
            {expired.has(intent.id) ? (
              <p className="empty-note muted">タスクがキャンセルされたため、この承認は無効になりました</p>
            ) : (
            <ApprovalCard intent={intent} decided={decisions[intent.id]} onDecide={(d) => onDecide(intent.id, d)} />
            )}
            {killed && <p className="small s-disabled">Kill Switch 発動中のため、承認しても実行されません。</p>}
          </>
        )}
      </main>
    </>
  )
}
