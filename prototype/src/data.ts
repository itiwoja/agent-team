// モックデータ。docs/design/06_ux_design/agents.md の「体験の流れ」に合わせる。

export type AgentStatus = 'active' | 'idle' | 'clamped' | 'disabled'

export type Agent = {
  id: string
  name: string
  icon: string
  status: AgentStatus
  jobs: number
  nextRun?: string
  note?: string
  repo?: string
}

export const agents: Agent[] = [
  { id: 'shiire', name: '仕入れ係', icon: '📦', status: 'active', jobs: 2, nextRun: '今日 15:00' },
  { id: 'news', name: 'ニュースリサーチャー', icon: '📰', status: 'active', jobs: 2, nextRun: '明日 7:00' },
  { id: 'commute', name: '朝の交通係', icon: '🚝', status: 'active', jobs: 1, nextRun: '明日 6:45' },
  { id: 'engineer', name: 'エンジニア', icon: '🛠️', status: 'clamped', jobs: 3, nextRun: '月 9:00', repo: 'owner/app', note: 'ポリシーにより制限中' },
  { id: 'weekly', name: '週次レビュー', icon: '🗂️', status: 'disabled', jobs: 1, note: '停止: ren「誤検知が多い」' },
]

export const statusLabel: Record<AgentStatus, string> = {
  active: '有効',
  idle: '準備中',
  clamped: '制限中',
  disabled: '停止中',
}

export type Msg =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'plan'; lines: string[] }
  | { kind: 'connect'; service: string }
  | { kind: 'approval'; id: string }
  | { kind: 'result'; title: string; items: { head: string; src: string }[] }
  | { kind: 'change'; what: string; why: string; cls: 'narrow' | 'neutral' | 'widen' }
  | { kind: 'handoff'; to: string }

export const newsChat: Msg[] = [
  { kind: 'agent', text: 'ニュースリサーチャーです。どんなニュースを、どのくらいの頻度で調べましょう？' },
  { kind: 'user', text: '毎朝、AI規制と半導体のニュースをまとめて Slack に送って' },
  {
    kind: 'plan',
    lines: ['毎朝 7:00（平日・休日とも）', 'テーマ：AI規制、半導体。各3件、1行の要約と出典URL', '届け先：Slack の自分宛て DM'],
  },
  { kind: 'connect', service: 'Slack' },
  { kind: 'agent', text: 'つながりました。最初の1回を今から実行します。' },
  { kind: 'approval', id: 'int-01' },
]

// 承認待ちの Intent（SCR-006・007）。MCP の書き込みと PR の2種類。
export type Risk = 'low' | 'medium' | 'high'

type IntentBase = { id: string; agentId: string; expiresIn: string; expiringSoon?: boolean; risk: Risk; riskReasons: string[]; hash: string }

export type McpIntent = IntentBase & {
  kind: 'mcp_call'
  tool: string
  server: string
  service: string
  destination: { label: string; raw: string }
  content: string
  options: { k: string; v: string }[]
  rule: string
  canAllowAlways: boolean
  taintedBy?: string[]
  fixed: string[]
  variable: string[]
}

export type PrIntent = IntentBase & {
  kind: 'open_pr'
  repo: string
  issue: number
  title: string
  base: string
  head: string
  summary: string
  selfReview: { result: string; fixes: number; open: string }
  files: { path: string; add: number; del: number }[]
  tests: { cmd: string; ok: boolean }[]
  cost: { used: number; cap: number; steps: number }
  rule: string
  policy: string
}

export type Intent = McpIntent | PrIntent

export const intents: Intent[] = [
  {
    kind: 'mcp_call',
    id: 'int-01',
    agentId: 'news',
    tool: 'slack.post_message',
    server: 'Slack MCP',
    service: 'Slack',
    destination: { label: '自分宛ての DM', raw: 'channel: D07ABC123 (@ikki)' },
    content: `【AI規制】EU AI Act の汎用AI向け実施規則が公表 — 出典 euractiv.com
【AI規制】米国州法の AI 開示義務、3州で成立 — 出典 reuters.com
【半導体】TSMC 2nm 量産の前倒しを発表 — 出典 nikkei.com
…ほか3件`,
    options: [{ k: 'unfurl_links', v: 'false' }],
    rule: 'mcp.write = approve',
    expiresIn: '23時間',
    risk: 'medium',
    riskReasons: ['+2 タスクが Web を読んでいる（汚染あり）', '+2 宛先がどのルールにも一致しない', '−1 自分宛て（scope: self）'],
    taintedBy: ['euractiv.com', 'reuters.com', 'nikkei.com'],
    canAllowAlways: true,
    hash: '7c1e94ab02d5',
    fixed: ['ツール：slack.post_message', '宛先：自分宛ての DM（D07ABC123）', 'unfurl_links：false'],
    variable: ['本文（毎回のニュースのまとめ）'],
  },
  {
    kind: 'open_pr',
    id: 'int-02',
    agentId: 'engineer',
    repo: 'owner/app',
    issue: 123,
    title: 'Fix login redirect loop',
    base: 'main',
    head: 'open-team/task-8f3a',
    expiresIn: '21時間',
    risk: 'medium',
    riskReasons: ['+2 依存ファイルの変更（package.json）', '+1 テストの変更なし'],
    summary: 'ログイン後のリダイレクト先を保存する処理で、未ログイン時にも /login を保存していたためループしていた。保存前に /login を除外し、セッション切れのテストを追加…',
    selfReview: { result: 'pass', fixes: 1, open: 'なし' },
    files: [
      { path: 'src/auth.ts', add: 40, del: 10 },
      { path: 'src/routes/login.tsx', add: 52, del: 12 },
      { path: 'src/lib/session.ts', add: 18, del: 6 },
      { path: 'package.json', add: 1, del: 1 },
      { path: 'package-lock.json', add: 9, del: 1 },
    ],
    tests: [{ cmd: 'npm test', ok: true }],
    cost: { used: 1.12, cap: 2.0, steps: 61 },
    rule: 'open_pr = approve',
    policy: 'エンジニア × policy a1b2c3d',
    hash: 'e3b0c442f9a1',
  },
  {
    kind: 'mcp_call',
    id: 'int-03',
    agentId: 'commute',
    tool: 'gmail.send_message',
    server: 'Gmail MCP',
    service: 'Gmail',
    destination: { label: '自分（me@example.com）', raw: 'to: me@example.com' },
    content: `件名：けさの通勤（6:45 時点）
ゆいレール：平常運転
国道58号 久茂地→旭橋：混雑（+12分）
おすすめ：7:10 発に1本早める`,
    options: [{ k: 'format', v: 'text' }],
    rule: 'mcp.write = approve',
    expiresIn: '38分',
    expiringSoon: true,
    risk: 'low',
    riskReasons: ['+2 タスクが Web を読んでいる（汚染あり）', '−1 自分宛て（scope: self）'],
    taintedBy: ['yui-rail.co.jp', 'google.com/maps'],
    canAllowAlways: true,
    hash: '51a0d7e3c8b2',
    fixed: ['ツール：gmail.send_message', '宛先：me@example.com', 'format：text'],
    variable: ['件名・本文（毎朝の交通のまとめ）'],
  },
]

export const riskLabel: Record<Risk, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }

// タスク（SCR-004・005）。状態は 04_functional_spec/status.md の tasks.status
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'executing' | 'succeeded' | 'completed' | 'rejected' | 'failed' | 'cancelled' | 'halted'

export type TimelineItem = { t: string; text: string; ok?: boolean; denied?: string; ai?: boolean }

export type Task = {
  id: string
  agentId: string
  title: string
  trigger: '手動' | 'スケジュール' | 'ラベル' | 'チャット'
  status: TaskStatus
  detail?: string
  updated: string
  phase?: string
  intentId?: string
  tainted?: boolean
  budget: { cost: number; costCap: number; steps: number; stepsCap: number; min: number; minCap: number; denials: number; denialsCap: number }
  timeline: TimelineItem[]
  report?: string
}

export const tasks: Task[] = [
  {
    id: 't-130',
    agentId: 'engineer',
    title: 'owner/app #130 Fix login redirect',
    trigger: 'ラベル',
    status: 'running',
    phase: 'implement',
    updated: '2分前',
    budget: { cost: 0.84, costCap: 2, steps: 32, stepsCap: 80, min: 12, minCap: 45, denials: 1, denialsCap: 3 },
    timeline: [
      { t: '12:03', text: 'plan 開始（claude-opus-5-5）' },
      { t: '12:05', text: 'read_file src/auth.ts', ok: true },
      { t: '12:06', text: 'write_file infra/x.tf', ok: false, denied: 'paths.deny[1]' },
      { t: '12:07', text: 'run_command npm test', ok: true },
      { t: '12:09', text: 'review 修正点 2件', ai: true },
    ],
  },
  {
    id: 't-news-1002',
    agentId: 'news',
    title: '毎朝のニュースまとめ（AI規制・半導体）',
    trigger: 'スケジュール',
    status: 'awaiting_approval',
    intentId: 'int-01',
    tainted: true,
    updated: '5分前',
    budget: { cost: 0.18, costCap: 0.5, steps: 14, stepsCap: 40, min: 3, minCap: 15, denials: 0, denialsCap: 3 },
    timeline: [
      { t: '7:00', text: 'スケジュールで開始' },
      { t: '7:01', text: 'web_search "EU AI Act" ほか 3件', ok: true },
      { t: '7:02', text: 'web_fetch euractiv.com ほか 5件', ok: true },
      { t: '7:02', text: '外部の内容を読んだため、このタスクを汚染ありにしました' },
      { t: '7:03', text: 'slack.post_message → 承認待ち' },
    ],
  },
  {
    id: 't-123',
    agentId: 'engineer',
    title: 'owner/app #123 Fix login redirect loop',
    trigger: '手動',
    status: 'awaiting_approval',
    intentId: 'int-02',
    updated: '10分前',
    budget: { cost: 1.12, costCap: 2, steps: 61, stepsCap: 80, min: 28, minCap: 45, denials: 0, denialsCap: 3 },
    timeline: [
      { t: '11:20', text: 'plan 開始（claude-opus-5-5）' },
      { t: '11:31', text: 'run_command npm test', ok: true },
      { t: '11:40', text: 'review 修正点 1件 → 修正', ai: true },
      { t: '11:48', text: 'open_pr → 承認待ち' },
    ],
  },
  {
    id: 't-commute-1002',
    agentId: 'commute',
    title: 'けさの通勤チェック',
    trigger: 'スケジュール',
    status: 'awaiting_approval',
    intentId: 'int-03',
    tainted: true,
    updated: '12分前',
    budget: { cost: 0.06, costCap: 0.3, steps: 6, stepsCap: 20, min: 1, minCap: 10, denials: 0, denialsCap: 3 },
    timeline: [
      { t: '6:45', text: 'スケジュールで開始' },
      { t: '6:46', text: 'web_fetch yui-rail.co.jp', ok: true },
      { t: '6:46', text: 'web_fetch google.com/maps', ok: true },
      { t: '6:47', text: 'gmail.send_message → 承認待ち' },
    ],
  },
  {
    id: 't-weekly-0929',
    agentId: 'weekly',
    title: '週次レビュー 2026-09-29',
    trigger: 'スケジュール',
    status: 'completed',
    detail: 'report',
    updated: '3日前',
    budget: { cost: 0.31, costCap: 1, steps: 22, stepsCap: 60, min: 6, minCap: 30, denials: 0, denialsCap: 3 },
    timeline: [
      { t: '9:00', text: 'スケジュールで開始' },
      { t: '9:04', text: 'list_issues owner/app', ok: true },
      { t: '9:06', text: 'submit_report', ok: true },
    ],
    report: `## 依存関係の脆弱性 2件
- lodash 4.17.20（high）… 4.17.21 で修正
- semver 7.5.1（medium）… 7.5.2 で修正

## 2週間動きのない Issue 3件
- #98 / #104 / #117

※ GitHub には書き込んでいません`,
  },
  {
    id: 't-99',
    agentId: 'engineer',
    title: 'owner/app #99 Refactor date utils',
    trigger: '手動',
    status: 'halted',
    detail: 'breaker: same_action_repeat',
    updated: '昨日',
    budget: { cost: 0.92, costCap: 2, steps: 80, stepsCap: 80, min: 31, minCap: 45, denials: 0, denialsCap: 3 },
    timeline: [
      { t: '15:10', text: 'plan 開始（claude-opus-5-5）' },
      { t: '15:32', text: 'run_command npm test', ok: false },
      { t: '15:33', text: 'run_command npm test', ok: false },
      { t: '15:41', text: '同じ操作を5回くり返したため停止（same_action_repeat）' },
    ],
  },
  {
    id: 't-news-1001',
    agentId: 'news',
    title: '毎朝のニュースまとめ（AI規制・半導体）',
    trigger: 'スケジュール',
    status: 'succeeded',
    tainted: true,
    updated: '昨日',
    budget: { cost: 0.17, costCap: 0.5, steps: 13, stepsCap: 40, min: 3, minCap: 15, denials: 0, denialsCap: 3 },
    timeline: [
      { t: '7:00', text: 'スケジュールで開始' },
      { t: '7:03', text: 'slack.post_message → 承認（ikki）' },
      { t: '7:21', text: 'slack.post_message 実行', ok: true },
    ],
  },
]

export const taskStatusLabel: Record<TaskStatus, string> = {
  queued: '待機中',
  running: '実行中',
  awaiting_approval: '承認待ち',
  executing: '実行中（外部作用）',
  succeeded: '成功',
  completed: '完了',
  rejected: '却下',
  failed: '失敗',
  cancelled: 'キャンセル',
  halted: '停止',
}

export const completedDetail: Record<string, string> = { report: 'レポート', dry_run: '試し実行', actions_declined: '外部作用なし' }

// 仕事（agent_jobs、SCR-017 の「仕事」タブ）
export type JobStatus = 'waiting_input' | 'active' | 'paused' | 'done'

export type Job = { id: string; agentId: string; title: string; when: string; deliver?: string; status: JobStatus; lastRun?: string; question?: string }

export const jobs: Job[] = [
  { id: 'j-news-1', agentId: 'news', title: 'AI規制と半導体のニュースまとめ', when: '毎朝 7:00', deliver: 'Slack · 自分宛ての DM', status: 'active', lastRun: '今日 7:00（承認待ち）' },
  { id: 'j-news-2', agentId: 'news', title: '決算ページの見張り（TSMC IR）', when: '1時間ごと', deliver: 'Web Push', status: 'active', lastRun: '今日 11:00（変化なし）' },
  { id: 'j-commute-1', agentId: 'commute', title: 'けさの通勤チェック', when: '平日 6:45', deliver: 'Gmail · 自分', status: 'active', lastRun: '今日 6:45（承認待ち）' },
  { id: 'j-eng-1', agentId: 'engineer', title: 'bug ラベルの Issue を直して PR', when: 'ラベル bug', deliver: 'GitHub PR', status: 'active', lastRun: '2分前' },
  { id: 'j-eng-2', agentId: 'engineer', title: '依存関係の更新', when: '毎週月 9:00', deliver: 'GitHub PR', status: 'paused', lastRun: '9/22' },
  { id: 'j-eng-3', agentId: 'engineer', title: 'CI の失敗を調べる', when: '', status: 'waiting_input', question: 'どのリポジトリの CI を見ますか？' },
  { id: 'j-weekly-1', agentId: 'weekly', title: '週次の Issue・依存関係レビュー', when: '毎週月 9:00', deliver: 'レポート', status: 'paused', lastRun: '9/29' },
]

export const jobStatusLabel: Record<JobStatus, string> = { waiting_input: '答え待ち', active: '動いている', paused: '一時停止', done: '終わった' }
