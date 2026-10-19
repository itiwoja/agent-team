import { useState } from 'react'
import { jobs as initialJobs, jobStatusLabel, type Job, type JobStatus } from '../data'
import { Sheet } from '../ui/Sheet'

const jobClass: Record<JobStatus, string> = { waiting_input: 's-pending', active: 's-active', paused: 's-idle', done: 's-idle' }

// SCR-017 の「仕事」タブ。一時停止・再開・削除（API-065、FR-037）。1エージェント10個まで（A-81）
export function AgentJobs({ agentId, agentName, onBack }: { agentId: string; agentName: string; onBack: () => void }) {
  const [list, setList] = useState<Job[]>(() => initialJobs.filter((j) => j.agentId === agentId))
  const [removing, setRemoving] = useState<Job | null>(null)
  const set = (id: string, status: JobStatus) => setList((l) => l.map((j) => (j.id === id ? { ...j, status } : j)))

  return (
    <main className="screen">
      <div className="section-head">
        <h2>仕事</h2>
        <span className="muted small">{list.length} / 10</span>
      </div>
      {list.length === 0 ? (
        <div className="empty-note">
          <p className="muted">まだ仕事がありません。チャットで頼むと、ここに並びます。</p>
          <button className="btn" onClick={onBack}>{agentName}に頼む</button>
        </div>
      ) : (
        <ul className="job-list">
          {list.map((j) => (
            <li key={j.id} className={'card job' + (j.status === 'paused' ? ' is-paused' : '')}>
              <div className="row-between">
                <b className="job-title">{j.title}</b>
                <span className={'badge ' + jobClass[j.status]}>{jobStatusLabel[j.status]}</span>
              </div>
              <div className="job-meta small muted">
                {j.when && <span>{j.when}</span>}
                {j.deliver && <span>→ {j.deliver}</span>}
              </div>
              {j.question && <p className="small s-pending">❓ {j.question}</p>}
              {j.lastRun && <p className="small muted">前回：{j.lastRun}</p>}
              <div className="card-actions">
                {j.status === 'waiting_input' ? (
                  <button className="btn" onClick={onBack}>チャットで答える</button>
                ) : j.status === 'active' ? (
                  // 一時停止は権限を狭める変更（narrow）なので確認なしで即時
                  <button className="btn" onClick={() => set(j.id, 'paused')}>一時停止</button>
                ) : (
                  <button className="btn" onClick={() => set(j.id, 'active')}>再開</button>
                )}
                <button className="btn btn-ghost" onClick={() => setRemoving(j)}>削除</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <Sheet title="この仕事を削除しますか？" onClose={() => setRemoving(null)}>
          <p><b>{removing.title}</b></p>
          <p className="small muted">今後は実行されません。過去のタスクと変更履歴は残ります。</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setRemoving(null)}>戻る</button>
            <button
              className="btn btn-danger"
              onClick={() => {
                setList((l) => l.filter((j) => j.id !== removing.id))
                setRemoving(null)
              }}
            >
              削除する
            </button>
          </div>
        </Sheet>
      )}
    </main>
  )
}
