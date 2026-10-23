// 線のアイコン（24px グリッド、stroke は currentColor）。絵文字だと OS ごとに見た目が揺れるため。
import type { ReactNode } from 'react'
type P = { size?: number }

const svg = (size: number, d: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)

export const MenuIcon = ({ size = 22 }: P) => svg(size, <><path d="M4 8h16" /><path d="M4 16h10" /></>)
export const ArrowUpIcon = ({ size = 20 }: P) => svg(size, <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>)
export const BackIcon = ({ size = 22 }: P) => svg(size, <path d="m15 5-7 7 7 7" />)
export const CloseIcon = ({ size = 22 }: P) => svg(size, <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>)
export const DoneIcon = ({ size = 20 }: P) => svg(size, <><path d="m5 12.5 4.5 4.5L19 7.5" /></>)
export const TasksIcon = ({ size = 20 }: P) => svg(size, <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>)
/* エージェント（まるい体に光る目：Avatar と同じ顔の線画） */
export const PacksIcon = ({ size = 20 }: P) => svg(size, <><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" /><path d="M4 8.5 12 13l8-4.5M12 13v7" /></>);
export const AgentsIcon = ({ size = 20 }: P) => svg(size, <><path d="M12 4c4.4 0 7 2.9 7 6.6S16.4 17 12 17s-7-2.7-7-6.4S7.6 4 12 4Z" /><path d="M9.5 10.5v.01M14.5 10.5v.01" strokeWidth={2.6} /><path d="M9 17v3M15 17v3" /></>)
/* チャット（吹き出し） */
export const ChatIcon = ({ size = 20 }: P) => svg(size, <><path d="M12 4.5c4.7 0 8 3 8 6.8s-3.3 6.7-8 6.7c-1 0-2-.1-2.9-.4L5 19.5l1.1-3.6C4.8 14.7 4 13.1 4 11.3 4 7.5 7.3 4.5 12 4.5Z" /></>)
export const CalendarIcon = ({ size = 20 }: P) => svg(size, <><rect x="4" y="5.5" width="16" height="14" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>)
export const CheckIcon = ({ size = 20 }: P) => svg(size, <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>)
export const StopIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
)
/* 開閉・移動の印（文字の ＞ ∧ ▾ はフォントで形が揺れるので線で描く）。
   dir="down" は開ける印で、open を渡すと上を向く（CSS の .chev で回る）。dir="right" は「押すと移る」印 */
export const Chevron = ({ size = 16, dir = "down", open }: P & { dir?: "down" | "right"; open?: boolean }) => (
  <svg
    className={`chev chev-${dir}${open ? " is-open" : ""}`}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {dir === "right" ? <path d="m9 6 6 6-6 6" /> : <path d="m6 9 6 6 6-6" />}
  </svg>
)
