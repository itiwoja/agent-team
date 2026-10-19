// 線のアイコン（24px グリッド、stroke は currentColor）。絵文字だと OS ごとに見た目が揺れるため。
import type { ReactNode } from 'react'
type P = { size?: number }

const svg = (size: number, d: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)

export const MenuIcon = ({ size = 22 }: P) => svg(size, <><path d="M4 8h16" /><path d="M4 16h10" /></>)
export const NewIcon = ({ size = 22 }: P) =>
  svg(size, <><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z" /></>)
export const ArrowUpIcon = ({ size = 20 }: P) => svg(size, <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>)
export const BackIcon = ({ size = 22 }: P) => svg(size, <path d="m15 5-7 7 7 7" />)
export const PlusIcon = ({ size = 22 }: P) => svg(size, <><path d="M12 5v14" /><path d="M5 12h14" /></>)
export const MicIcon = ({ size = 20 }: P) =>
  svg(size, <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>)
export const ChevronDownIcon = ({ size = 16 }: P) => svg(size, <path d="m6 9 6 6 6-6" />)
export const HomeIcon = ({ size = 20 }: P) => svg(size, <><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /></>)
export const TasksIcon = ({ size = 20 }: P) => svg(size, <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>)
export const CheckIcon = ({ size = 20 }: P) => svg(size, <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>)
export const SettingsIcon = ({ size = 20 }: P) =>
  svg(size, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>)
export const StopIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
)
