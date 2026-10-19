import type { ReactNode } from 'react'
import { StopIcon } from './icons'

// ChatGPT 風：境界線なしの薄いヘッダー。Kill Switch は常に出す（common-ui.md）が、丸い停止アイコンに縮める。
export function AppHeader({ title, left, right, onKill, killed }: { title: ReactNode; left?: ReactNode; right?: ReactNode; onKill: () => void; killed: boolean }) {
  return (
    <>
      <header className="appheader">
        {left}
        <div className="appheader-title">{title}</div>
        {right}
        <button className={'kill-btn' + (killed ? ' is-killed' : '')} onClick={onKill} aria-label="Kill Switch：すべてのエージェントを止める">
          <StopIcon />
        </button>
      </header>
      {killed && (
        <div className="banner banner-danger" role="status">
          Kill Switch 発動中 · すべてのエージェントと外部作用を止めています
        </div>
      )}
    </>
  )
}
