import { useState } from 'react'
import { Sheet } from './Sheet'

export function KillSwitchSheet({ killed, onClose, onConfirm }: { killed: boolean; onClose: () => void; onConfirm: () => void }) {
  const [reason, setReason] = useState('')
  if (killed) {
    return (
      <Sheet title="Kill Switch を解除する" onClose={onClose}>
        <p className="muted">解除はワークスペースの owner だけができます。止まったタスクは再開されません。</p>
        <label className="field">
          <span>理由（必須）</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
        </label>
        <div className="sheet-actions">
          <button className="btn" onClick={onClose}>やめる</button>
          <button className="btn btn-primary" disabled={!reason.trim()} onClick={onConfirm}>解除する</button>
        </div>
      </Sheet>
    )
  }
  return (
    <Sheet title="すべて止めますか？" onClose={onClose}>
      <p>実行中のタスク <b>2件</b> と、承認待ち <b>1件</b> を止めます。スケジュールも起動しなくなります。</p>
      <div className="sheet-actions">
        <button className="btn" onClick={onClose}>やめる</button>
        <button className="btn btn-danger" onClick={onConfirm}>すべて止める</button>
      </div>
    </Sheet>
  )
}
