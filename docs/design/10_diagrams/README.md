# 10. ER図 / シーケンス図 / 状態遷移図
- プロジェクト：Agent-Team-Open ／ 版数：v1.2（2026-10-24） ／ インプット：[08_database](../08_database/README.md)、[09_api](../09_api/README.md)

> **3行で**
> 1. シーケンス図は 13 本（[sequences.md](sequences.md)）。v1.2 で控えを取る・戻す（FR-100）を足した。v1.1 でメインの書き込みの承認（UC-054 4a）を足した。v1.0 で足したのは、きっかけからターン・振り分け・報告まで・webhook・ルーチンの提案・オートレビュー・要約・VM が起きて眠るの 6 本。
> 2. 状態遷移図は 12 個（[states.md](states.md)）。v1.2 で `workspace.vm_op`・`vm_home_state` を足した。v1.0 で足したのは `wakes`・`turns`・画面の番・予約・ルーチンの提案。
> 3. ER図は常駐の表と VM の表の 2 枚に分けて描く（今の表の全体は `schema.ts`）。

## 🧭 判断してほしいこと
なし

## 全体図
```mermaid
flowchart LR
 W["きっかけ<br/>UC-054"] --> T["メインのターン"]
 T -->|"delegate"| K["タスク UC-055"]
 K --> A["VM の 1 歩 UC-046"]
 A -->|"合図"| R["オートレビュー UC-059"]
 R -->|"stop"| B["人の確認 UC-047"]
 A -->|"交代"| C["UC-048 交代"]
 K -->|"コマンド"| E["UC-053 ターミナル"]
 K -.->|"task_done"| W
 H["webhook UC-057"] --> W
 RT["ルーチン UC-056"] --> W
 T -.->|"10 分後"| S["要約 UC-060"]
 A -.->|"起きる・眠る"| V["UC-061"]
```
見てほしいところ：どの図もきっかけ（UC-054）から始まり、タスクの終わりがまたきっかけに戻る輪になっている。

## 要点
- 送信からメインの返事・タスクの報告・通知までは 1 本の図（[UC-054・055](sequences.md#uc-054055きっかけからターン振り分け報告まで)）
- webhook は「大きさ → 受け口 → 署名 → 件数 → 重複」の順で確かめる（[UC-057](sequences.md#uc-057webhook-で起きる)）
- オートレビューに会話は渡さない。`stop` なら人の確認に回る（[UC-059](sequences.md#uc-059オートレビュー)）
- 変える操作の1歩は「画面の番 → Claude → 直前の確かめ → 確かめ（dryRun）→ Kernel → 中身のハッシュつきの実行」を、返った操作の列の順に（[UC-046](sequences.md#uc-046vm-で操作する1歩)）
- ターンは 1 つずつ。持ち主のチャットは動いているターンの次の歩みに入る（[turns.status](states.md#turnsstatus)）

---

## 詳細

### ER図：常駐の表
```mermaid
erDiagram
 wakes }o--o| turns : "consumed_turn_id"
 wakes }o--o| tasks : "target_task_id"
 turns ||--o{ chat_messages : "turn_id"
 turns ||--o{ tasks : "turn_id"
 agents ||--o{ tasks : "agent_id"
 turns ||--o{ task_steps : "owner_id"
 tasks ||--o{ task_steps : "owner_id"
 turns }o--|| context_snapshots : "context_snapshot_id"
 turns ||--o{ scheduled_wakes : "turn_id"
 turns ||--o{ routine_proposals : "turn_id"
 agents ||--o{ routines : "agent_id"
 agents ||--o{ memory_notes : "agent_id"
 turns ||--o{ memory_facts : "source_turn_id"
 webhooks ||--o{ wakes : "hook_id"
 turns ||--o{ action_intents : "turn_id"
 push_subscriptions ||--o{ push_outbox : "subscription_id"
 wakes {
  text id PK
  text origin
  text source_key UK
  text target_kind
  text hook_id FK
  text body_sha256
  text consumed_step_key
  int tainted
  text status
 }
 turns {
  text id PK
  text status
  text budget_class
  int tainted
  text context_snapshot_id FK
  text closing_at
 }
 context_snapshots {
  text id PK
  text summary
  int tainted
  text untainted_at
 }
 push_outbox {
  text id PK
  text notice_id
  text subscription_id FK
  text status
 }
 tasks {
  text id PK
  text agent_id FK
  text turn_id FK
  text brief
  text report
  int tainted
 }
 chat_messages {
  text id PK
  text role
  text kind
  text turn_id FK
 }
```
`memory_log`・`memory_search`・`vm_snapshots` は外部キーを持たない。`webhooks` から `wakes` へは `hook_id` で結ぶ（D-284）。`action_intents`・`approvals`・`policy_decisions` は `task_id` か `turn_id` のどちらか一方を持つ（D-275）。

### ER図：VM の表
```mermaid
erDiagram
 boxes |o--o| tasks : "screen_task_id"
 boxes ||--o{ browser_actions : "box_id"
 tasks ||--o{ browser_actions : "task_id"
 browser_actions ||--o| auto_reviews : "auto_review_id"
 browser_actions }o--o| browser_checks : "check_id"
 auto_reviews |o--o| browser_checks : "check_id"
 boxes ||--o{ takeovers : "box_id"
 boxes ||--o{ sandbox_commands : "box_id"
 tasks ||--o{ sandbox_commands : "task_id"
 tasks ||--o{ action_intents : "task_id"
 action_intents ||--o| approvals : "intent_id"
 boxes {
  text id PK
  text status
  text mode
  text control
  int control_epoch
  int screen_epoch
  text screen_task_id FK
 }
 browser_actions {
  text id PK
  text box_id FK
  text verdict
  text auto_review_id FK
  text check_id FK
 }
 auto_reviews {
  text id PK
  text action_id UK
  text verdict
 }
 browser_checks {
  text id PK
  text action_id UK
  text status
  int screen_epoch
  text content_hash
 }
```

### 図の一覧
| 種類 | 図 | ファイル |
|---|---|---|
| シーケンス | UC-054・055 きっかけからターン・振り分け・報告まで／UC-054 4a メインの書き込みと承認／UC-057 webhook／UC-056 ルーチンの提案／UC-059 オートレビュー／UC-060 要約／UC-061 VM が起きて眠る／UC-046 VM の 1 歩／UC-047 こわい操作の確認／UC-048 交代／UC-053 ターミナル／FR-084 再開／FR-100 控えを取る・戻す | [sequences.md](sequences.md) |
| 状態遷移 | `wakes.status`／`turns.status`／画面の番／`scheduled_wakes.status`／`routine_proposals.status`／`boxes.status`／`boxes.control`／`takeovers.status`／`browser_checks.status`／`sandbox_commands.status`／`workspace.vm_op`／`workspace.vm_home_state` | [states.md](states.md) |

## このドキュメントで決まったこと
- なし（図は 03・04・08・09 の内容を描いたもの）
