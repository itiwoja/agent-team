import { AppHeader } from '../ui/AppHeader'
import { MenuIcon } from '../ui/icons'

export function Placeholder({ title, onKill, killed, onMenu }: { title: string; onKill: () => void; killed: boolean; onMenu: () => void }) {
  return (
    <>
      <AppHeader left={<button className="icon-btn" onClick={onMenu} aria-label="メニュー"><MenuIcon /></button>} title={title} onKill={onKill} killed={killed} />
      <main className="screen empty">
        <p className="muted">「{title}」はまだ作っていません。</p>
      </main>
    </>
  )
}
