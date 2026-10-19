import { ArrowUpIcon, MicIcon, PlusIcon } from './icons'

// 下に浮かぶ丸い入力欄。空のときはマイク、入力があると送信ボタンに替わる。
export function Composer({ value, onChange, onSend, placeholder }: { value: string; onChange: (v: string) => void; onSend: () => void; placeholder: string }) {
  const has = value.trim().length > 0
  return (
    <div className="composer">
      <div className="composer-box">
        <button className="round-btn ghost" aria-label="添付"><PlusIcon /></button>
        <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && has && onSend()} placeholder={placeholder} />
        {has ? (
          <button className="round-btn solid" onClick={onSend} aria-label="送信"><ArrowUpIcon /></button>
        ) : (
          <button className="round-btn ghost" aria-label="音声入力"><MicIcon /></button>
        )}
      </div>
    </div>
  )
}
