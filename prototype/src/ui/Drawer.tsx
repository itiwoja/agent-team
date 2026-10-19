import { agents, statusLabel } from '../data'
import { CheckIcon, HomeIcon, SettingsIcon, TasksIcon } from './icons'

// ボトムタブの代わりの左ドロワー（ChatGPT の会話履歴の位置にエージェントを並べる）
// v0.9：日常の入口は SCR-019 だけ。ほかはこのメニューの奥（ask-and-check.md §メニュー）
const nav = [
  { key: '', label: '頼む・チェック', icon: <CheckIcon /> },
  { key: 'done', label: '済んだもの', icon: <TasksIcon /> },
  { key: 'audit', label: '記録', icon: <HomeIcon /> },
]

export function Drawer({ current, pending, onClose }: { current: string; pending: number; onClose: () => void }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <nav className="drawer" aria-label="メイン" onClick={(e) => e.stopPropagation()}>
        <a href="#/" className="drawer-new" onClick={onClose}>
          <span className="logo" aria-hidden>◎</span>
          <span>open-team</span>
        </a>
        <div className="drawer-nav">
          {nav.map((n) => (
            <a key={n.key} href={`#/${n.key}`} onClick={onClose} className={'drawer-item' + (current.split('/')[0] === n.key ? ' is-current' : '')}>
              {n.icon}
              <span>{n.label}</span>
              {n.key === '' && pending > 0 && <span className="count">{pending}</span>}
            </a>
          ))}
        </div>
        <a href="#/agents" onClick={onClose} className="drawer-label">エージェント</a>
        <div className="drawer-agents">
          {agents.map((a) => (
            <a key={a.id} href={`#/agents/${a.id}`} onClick={onClose} className={'drawer-item' + (current === 'agents/' + a.id ? ' is-current' : '')}>
              <span className="avatar xs" aria-hidden>{a.icon}</span>
              <span className="drawer-agent-name">{a.name}</span>
              {a.status !== 'active' && <span className={'dot s-' + a.status} title={statusLabel[a.status]} />}
            </a>
          ))}
        </div>
        <a href="#/more" onClick={onClose} className="drawer-foot">
          <span className="me" aria-hidden>I</span>
          <span>ルールと設定</span>
          <SettingsIcon />
        </a>
      </nav>
    </div>
  )
}
