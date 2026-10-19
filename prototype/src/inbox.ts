// SCR-019 頼む・チェック のモックデータ。docs/design/06_ux_design/ask-and-check.md の「行の種類」に合わせる。

// 報告（○）・送る前の確認（○送る）・質問（選択肢）の3種類
export type Item =
  | { kind: 'report'; id: string; agentId: string; title: string; at: string; failed?: boolean; body?: string; rehearsal?: { none: number; governed: number; tightened: number; total: number } }
  | { kind: 'send'; id: string; agentId: string; title: string; intentId: string; at: string }
  | { kind: 'widen'; id: string; agentId: string; title: string; gain: string; why: string; at: string }
  | { kind: 'question'; id: string; agentId: string; title: string; choices: string[]; why: string; at: string; free?: boolean }

export type Running = { id: string; agentId?: string; text: string }

export type Done = { id: string; agentId?: string; title: string; how: string; at: string }

export const initialItems: Item[] = [
  { kind: 'send', id: 'i-commute', agentId: 'commute', title: 'けさの通勤のまとめをメールで送る', intentId: 'int-03', at: '6:47' },
  { kind: 'send', id: 'i-news', agentId: 'news', title: '朝のニュースまとめを Slack に送る', intentId: 'int-01', at: '7:03' },
  { kind: 'send', id: 'i-pr', agentId: 'engineer', title: 'ログインのループを直した PR を作る', intentId: 'int-02', at: '11:48' },
  {
    kind: 'widen',
    id: 'i-widen',
    agentId: 'shiire',
    title: '仕入れ係のできることを増やす',
    gain: '仕入れ先（tanaka@example.com）へのメール送信',
    why: '「在庫が切れそうなら発注メールも作って」と頼まれたため。送る前には毎回ここで確認します。',
    at: '10:12',
  },
  {
    kind: 'question',
    id: 'i-q-store',
    agentId: 'shiire',
    title: 'どちらの店舗の在庫を見ますか？',
    choices: ['本店', '2号店', '両方'],
    why: '在庫表が店舗ごとに2つあり、どちらか決められませんでした。',
    at: '10:15',
    free: true,
  },
  {
    kind: 'question',
    id: 'i-q-unknown',
    agentId: 'shiire',
    title: '昨日の発注メールが届いたか分かりません',
    choices: ['届いていた', '届いていない'],
    why: '送信の途中で応答が途切れました。もう一度送ると二重発注になるおそれがあるので、自動では送り直しません。',
    at: '昨日',
  },
  {
    kind: 'report',
    id: 'i-rehearsal',
    agentId: 'shiire',
    title: '練習で穴を2つ見つけ、締めました',
    at: '9:40',
    rehearsal: { none: 7, governed: 2, tightened: 0, total: 12 },
    body: '意地悪な状況12個（値上がり・単位の取り違え・返信の中の指示 など）を模擬の世界で試しました。\n・値上がり30%でもそのまま発注しそうになった → 上限の金額を足しました\n・「箱」と「個」の取り違え → 数量の確認を足しました\n同じ条件で試し直し、すり抜けは0件です。',
  },
  {
    kind: 'report',
    id: 'i-weekly',
    agentId: 'weekly',
    title: '週次レビューをまとめました',
    at: '9:06',
    body: '依存関係の脆弱性 2件（lodash・semver）\n2週間動きのない Issue 3件（#98 / #104 / #117）\nGitHub には書き込んでいません。',
  },
  {
    kind: 'report',
    id: 'i-fail',
    agentId: 'engineer',
    title: '日付の処理の整理を途中で止めました',
    failed: true,
    at: '昨日',
    body: 'テストの失敗を同じやり方で5回くり返したため、自分で止まりました（same_action_repeat）。かかった費用 $0.92。',
  },
]

export const initialRunning: Running[] = [
  { id: 'r-130', agentId: 'engineer', text: 'ログイン画面の不具合（#130）を直しています' },
  { id: 'r-ir', agentId: 'news', text: 'TSMC の決算ページを見張っています' },
]

export const initialDone: Done[] = [
  { id: 'd-1', agentId: 'news', title: '朝のニュースまとめを Slack に送る', how: '送った', at: '昨日 7:21' },
  { id: 'd-2', agentId: 'commute', title: 'けさの通勤のまとめ', how: '見た', at: '昨日 6:50' },
]

// 頼んだ内容から担当を決める（本物は設定プランナー。ここではキーワードだけ）
export function route(text: string): string {
  if (/在庫|発注|仕入/.test(text)) return 'shiire'
  if (/ニュース|記事|調べ/.test(text)) return 'news'
  if (/PR|バグ|コード|リポジトリ|直して/.test(text)) return 'engineer'
  if (/電車|道|通勤|交通/.test(text)) return 'commute'
  return 'news'
}
