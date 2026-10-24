# 10. ER図 / シーケンス図 / 状態遷移図
- プロジェクト：Agent-Team-Open ／ 版数：v0.6（2026-10-24） ／ インプット：[08_database](08_database.md)、[09_api](09_api.md)

> **3行で**
> 1. シーケンス図は5本：VM で操作する1歩（UC-046）・こわい操作の確認（UC-047）・交代（UC-048）・VM のターミナル（UC-053）・再起動からの再開（FR-084）。
> 2. 状態遷移図は5つ：`boxes.status`・`boxes.control`・`takeovers.status`・`browser_checks.status`・`sandbox_commands.status`。
> 3. ER図は新しい表と、それがぶら下がる今の表だけを描く（今の表の全体は `schema.ts`）。

## 🧭 判断してほしいこと
なし

## 全体図
```mermaid
flowchart LR
 A["UC-046 1歩"] -->|"申告・合図"| B["UC-047 確認"]
 A -->|"交代"| C["UC-048 交代"]
 A -.->|"再起動"| D["FR-084 再開"]
 A -->|"コマンド"| E["UC-053 ターミナル"]
```
見てほしいところ：どの図も UC-046 の1歩から分かれる。ターミナル（UC-053）は VM の中のコマンドで、判定せず自由に実行し、VM の外に効く書き込みだけ確認する。

## 要点
- 変える操作の1歩は「Claude → 確かめ（dryRun）→ Kernel → 中身のハッシュつきの実行 → スクショ」（[UC-046](#uc-046vm-で操作する1歩)）
- ○ は `pending → executing` を1回だけ取れたときに実行する（[UC-047](#uc-047こわい操作の確認)）
- 交代は「渡す準備」でエージェントを止めてから、人に渡す（[UC-048](#uc-048交代)）
- ターミナルは VM の中で自由に実行し、出力は汚染として扱う。PR にするときだけ Intent・確認を通す（[UC-053](#uc-053vm-のターミナル)）

---

## 詳細

### ER図
```mermaid
erDiagram
 agents ||--o| browser_profiles : "agent_id"
 agents ||--o{ tasks : "agent_id"
 tasks ||--o{ boxes : "task_id"
 agents ||--o{ boxes : "agent_id"
 boxes ||--o{ browser_actions : "box_id"
 boxes ||--o{ browser_checks : "box_id"
 browser_actions }o--o| browser_checks : "check_id"
 boxes ||--o{ takeovers : "box_id"
 boxes ||--o{ sandbox_commands : "box_id"
 tasks ||--o{ sandbox_commands : "task_id"
 tasks ||--o{ action_intents : "task_id"
 action_intents ||--o| approvals : "intent_id"
 tasks ||--o{ task_steps : "owner_id"
 boxes {
  text id PK
  text agent_id FK
  text task_id FK
  text status
  text control
  int control_epoch
 }
 browser_actions {
  text id PK
  text box_id FK
  int seq
  text kind
  text verdict
  text outcome
  text check_id FK
 }
 browser_checks {
  text id PK
  text box_id FK
  text action_id
  text status
  text content_hash
 }
 sandbox_commands {
  text id PK
  text box_id FK
  text task_id FK
  text tool
  text status
 }
 takeovers {
  text id PK
  text box_id FK
  text status
 }
 task_steps {
  text owner_kind PK
  text owner_id PK
  text step_key PK
  text status
 }
```

### シーケンス図

### UC-046：VM で操作する1歩
```mermaid
sequenceDiagram
 participant R as 実行役（本体）
 participant C as Claude API
 participant CU as computer（本体）
 participant K as Kernel
 participant BM as box-manager
 participant B as box-agent
 R->>R: task_steps に started（費用を予約）
 R->>C: messages（スクショつき）
 C-->>R: tool_use left_click(812,604)
 R->>CU: 実行して
 CU->>BM: API-103 dryRun（actionId・controlEpoch）
 BM->>B: 確かめ
 B-->>CU: button「次へ」 example.jp・contentHash
 CU->>K: judgeBrowserAction
 K-->>CU: allow
 CU->>BM: API-103 実行（expect: contentHash）
 BM->>B: 同じなら xdotool
 B-->>CU: executed・スクショ
 CU-->>R: スクショ（browser_actions に allowed・executed）
 R->>R: task_steps に done（費用を精算）
```

### UC-047：こわい操作の確認
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant W as 画面
 participant CU as computer（本体）
 participant K as Kernel
 participant BM as box-manager
 participant C as Claude API
 CU->>K: judgeBrowserAction（name「予約を確定する」）
 K-->>CU: approve（T-3）
 CU->>CU: browser_checks（pending・30分・contentHash）、tasks は awaiting_approval
 CU-->>W: SSE の知らせ
 O->>W: ○
 W->>CU: API-110 approve
 CU->>CU: pending → executing（条件つきの更新。取れなければ 409）
 CU->>BM: API-103 実行（actionId・expect: contentHash）
 alt 中身が同じ
  BM-->>CU: executed
  CU-->>W: executed
 else 中身が違う
  BM-->>CU: 409 CONTENT_CHANGED
  CU->>CU: 確認を expired（page_changed）。新しい確認は作らない
  CU->>C: 新しいスクショで「画面が変わったので実行しなかった」
  CU-->>W: page_changed
 else 答えがない
  CU->>CU: unknown_outcome、Claude に「分からない」
  CU-->>W: unknown_outcome
 end
```

### UC-048：交代
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant W as 画面（noVNC）
 participant CORE as 本体
 participant BM as box-manager
 participant C as Claude API
 C-->>CORE: request_takeover「ログインしてください」
 CORE-->>W: 交代の頼み（SSE の知らせ）
 O->>W: 手を貸す
 W->>CORE: API-090 takeover
 CORE->>CORE: control = handing_over、epoch +1
 CORE->>BM: API-113 control=handing_over（epoch）
 CORE->>C: 動いている呼び出しを中止（返った操作は捨てる）
 CORE->>CORE: llm の歩みを done（aborted）、費用を精算
 CORE->>CORE: この VM の pending の確認を expired（taken_over）
 CORE->>BM: 動いている操作の終わりを待つ
 CORE->>CORE: control = human
 CORE->>BM: API-113 control=human（epoch）
 CORE-->>W: 200
 W->>CORE: API-089 screen?mode=control
 CORE->>BM: API-106 vnc
 O->>W: ログインする
 O->>W: 返す
 W->>CORE: API-091 handback
 CORE->>CORE: control = agent、epoch +1
 CORE->>BM: API-113 control=agent（epoch）
 CORE->>BM: API-105 screenshot
 CORE->>C: 「人が操作した」＋スクショ
```

### UC-053：VM のターミナル
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant R as 実行役（本体）
 participant G as gateway
 participant BM as box-manager
 participant B as box-agent
 participant C as Claude API
 participant K as Kernel
 participant W as 画面
 R->>G: リポジトリを頼む
 G->>G: GitHub から tar を取る
 G->>BM: API-118 PUT files（tar）
 BM->>B: VM に展開
 C-->>R: tool_use run_command(npm test)
 R->>BM: API-117 commands（actionId・controlEpoch・timeoutSec）
 BM->>B: 実行（VM の中なので判定しない）
 B-->>R: ok・exitCode・output（64KB まで・汚染）
 R->>C: 出力を渡す（外の内容として扱う）
 Note over C,R: run_command・write_file を繰り返す（最大 200 回）
 R->>BM: API-118 GET files（tar）
 BM-->>R: 変更後の tar
 R->>R: 差分にして Intent に乗せる
 R->>K: 判定（書き込みなので確認）
 K-->>R: approve
 R-->>W: 確認カード
 O->>W: ○
 W->>R: API-019 decision
 R->>G: PR を作る
 G-->>R: PR の URL
```

### FR-084：再起動からの再開
```mermaid
sequenceDiagram
 participant CORE as 本体（起動）
 participant DB as SQLite
 participant BM as box-manager
 CORE->>DB: 終わっていない依頼・タスク・確認・交代
 CORE->>DB: 表のとおりに戻す（FR-084）
 CORE->>BM: API-109 一覧
 CORE->>BM: 残っている VM を止める（host_restart）
 loop VM を使っていたタスクごと
  CORE->>BM: API-101 新しい世代の VM を起こす
  CORE->>DB: task_steps の done をなぞる（古いスクショは使わない）
  CORE->>CORE: Claude に「VM を起こし直した」＋新しいスクショ
 end
```

### 状態遷移図

### boxes.status
```mermaid
stateDiagram-v2
 [*] --> starting
 starting --> running : box-agent が応答
 starting --> failed : 60秒応答なし
 running --> stopping : タスクの終わり・持ち主・期限・15分操作なし
 stopping --> stopped
 running --> failed : 落ちた
 stopped --> [*]
 failed --> [*]
```

### boxes.control
```mermaid
stateDiagram-v2
 [*] --> agent
 agent --> handing_over : API-090
 handing_over --> human : 動いている操作が終わった
 human --> agent : API-091
```

### takeovers.status
```mermaid
stateDiagram-v2
 [*] --> requested : request_takeover
 [*] --> active : 持ち主が自分から代わる
 requested --> active : API-090
 requested --> expired : 30分・再起動
 active --> ended : API-091
 active --> expired : 15分操作なし・再起動
 ended --> [*]
 expired --> [*]
```

### browser_checks.status
```mermaid
stateDiagram-v2
 [*] --> pending
 pending --> executing : ○（API-110）
 pending --> rejected : ×
 pending --> expired : 30分・交代・VM の起こし直し
 executing --> executed : 実行した
 executing --> expired : 中身が違う（page_changed）
 executing --> unknown_outcome : 答えがない・再起動
 executed --> [*]
 rejected --> [*]
 expired --> [*]
 unknown_outcome --> [*]
```

### sandbox_commands.status
```mermaid
stateDiagram-v2
 [*] --> queued
 queued --> running : box-agent が受けた
 running --> done : 終わった（ok・exit_code）
 running --> expired : タイムアウト・再起動
 done --> [*]
 expired --> [*]
```

## このドキュメントで決まったこと
- なし（図は 03・04・08・09 の内容を描いたもの。UC-053 と `sandbox_commands.status` は D-178）
