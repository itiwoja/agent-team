# 10. シーケンス図：エージェント（自己設定・トリガー）
- 入口：[README](README.md) ／ 関連：[03](../03_use_cases/README.md)、[04](../04_functional_spec/README.md)、[09](../09_api/README.md)

> **3行で**
> 1. 今のエージェントの作り方は「名前を付けて頼む」（v0.5）。お願いから設定プランナーが変更案を作り、Kernel の `classify()` が `widen` と判定したものだけユーザーに確認する。
> 2. 起動のしかた（スケジュール・メンション）は v0.2 の図のまま有効。スケジュールは v0.5 から仕事（job）ごとになる（`agent_schedules.job_id`）。
> 3. 下書き → 試し実行 → 公開PR の図は「v0.2（置き換え済み）」として末尾に残す。残る GitOps モードの流れは未設計（Q-81）。

## UC-026：お願いから仕事を作る（自己設定）

フェーズ0。UC-025（名前を付けて作る）の後、チャットでお願いを送ったときの流れ（14 §自己設定の仕組み）。

```mermaid
sequenceDiagram
    autonumber
    actor U as ユーザー
    participant C as エージェントのチャット（api）
    participant P as 設定プランナー（LLM）
    participant K as Kernel
    participant G as Gateway
    participant S as スケジューラー

    U->>C: お願い（自然言語）
    C->>P: お願い ＋ 現在の定義 ＋ ワークスペースのポリシー ＋ 使えるコネクタの一覧
    P-->>C: 設定の変更案（仕事の追加・境界の差分・確認したいこと）
    C->>K: classify(現在の定義, 変更案, ポリシー)
    K-->>C: narrow / neutral / widen ＋ 足りないもの（未接続のコネクタ・未分類のツール）
    alt 推測できない情報がある
        C-->>U: 質問を1つだけ出す
        U->>C: 答え
    end
    alt widen を含む、またはコネクタが未接続
        C-->>U: 確認カード（何が増えるか）／接続ボタン
        U->>C: 承認・接続
    end
    C->>K: compose() で実効ポリシーを計算し、新しいスナップショットを作る
    C->>S: トリガーを登録
    opt すぐ実行する仕事（once、または初回の試し）
        S->>G: 通常のタスクとして実行（外部作用は Intent）
    end
    C-->>U: 「こうします」の要約と開始の連絡
```
見てほしいところ：LLM（設定プランナー）は変更案を出すだけで、反映するかどうかは Kernel の `classify()` が決める。`widen` はユーザーの承認なしに反映されない（BR-47）。

- 設定プランナーの出力は定義の差分（JSON）に限り、FR-022 の検証を通らなければ反映しない。v0.3 の設計アシスタント（FR-024）を置き換える。
- 設定プランナーの呼び出しはタスクとは別で、外部の内容を読まないので `tainted` にならない。会話に貼られた外部の文章は、ユーザーの発言として記録する。
- 質問は1つのお願いにつき1つまで（BR-49）。答えが返らなければ仕事は `waiting_input` のまま止める。
- 変更案の状態は [設定の変更の状態遷移](states.md#設定の変更agent_config_changesstatus)。

## UC-021：スケジュールによる起動（v0.2）

フェーズ0。v0.5 からスケジュールは仕事ごと（`agent_schedules.job_id`）。

```mermaid
sequenceDiagram
    participant K as worker（毎分）
    participant D as DB
    participant G as gateway
    participant GH as GitHub
    participant Q as ジョブキュー

    K->>D: next_run_at を過ぎた agent_schedules を取得（FOR UPDATE SKIP LOCKED）
    K->>D: agents.status・Kill Switch・max_runs_per_day を確認
    K->>D: 前回のタスク（last_task_id）が未完了かを確認（BR-29）
    alt 前回のタスクが未完了
        K->>D: audit trigger.skipped（previous_run_active）、next_run_at・last_result 更新
    else 前回のタスクが終了済み、またはなし
        K->>D: エージェント担当者（定義の owner）が maintainer 以上か（memberships）
        K->>G: GET /gw/v1/repos/{repoId}/permissions/{owner}
        G->>GH: リポジトリへの権限を取得
        G-->>K: 書き込み権限の有無
        alt 条件を満たす（BR-25）
            K->>D: BEGIN、tasks INSERT(queued, trigger_type=schedule, requester=担当者, prompt,<br/>agent_snapshot_id を固定)、last_task_id・next_run_at・last_result 更新、audit task.created
            K->>Q: 実行ジョブを登録（同じトランザクション）、COMMIT
        else 満たさない
            K->>D: audit trigger.skipped（理由）、next_run_at・last_result 更新
        end
    end
```
見てほしいところ：前回のタスクが未完了なら起動しない（BR-29）。タスクの作成とジョブの登録は同じトランザクション。担当者の権限確認（gateway・GitHub）は開発エージェントの場合の手順。

## UC-021：メンションによる起動（v0.2）

フェーズ1（GitHub が要る）。

```mermaid
sequenceDiagram
    actor C as コメントしたユーザー
    participant GH as GitHub
    participant A as api
    participant K as worker
    participant G as gateway
    participant D as DB
    participant WP as Web Push

    C->>GH: Issue にコメント「@open-team bug-fixer 先にテストを書いて」
    GH->>A: POST /webhooks/github issue_comment.created（API-035）
    A->>A: 署名を検証
    A->>D: webhook_deliveries INSERT、処理ジョブを登録
    K->>K: 本文の先頭が「@open-team エージェントID」かを判定（A-41）
    K->>D: コメントしたユーザーを users・memberships と照合
    K->>G: GitHub 上の書き込み権限を確認（BR-07）
    K->>D: agents.status・github_mention トリガー・Kill Switch・BR-29・max_runs_per_day を確認
    alt 条件を満たす
        K->>D: BEGIN、tasks INSERT(queued, trigger_type=github_mention, instructions=残りの本文)、<br/>実行ジョブ登録、audit task.created、COMMIT
        K->>WP: 依頼者へ「タスクを作成しました」
    else 満たさない
        K->>D: audit trigger.skipped（理由コード）
    end
    Note over GH,K: コメントでの返信はしない（Won't）
```
見てほしいところ：コメントしたユーザーの open-team と GitHub 両方の権限を確かめてからタスクを作る。コメントでの返信はしない（Won't）。

---

## v0.2（置き換え済み）：エージェントの作成 → 試し実行 → 公開 → 有効化

v0.5 で「名前を付けて頼む」に置き換えた（ADR-026）。下書き（TBL-021）・API-043〜048 は廃止。GitOps モードと詳細設定の試し実行で残る部分の流れは Q-81。

<details>
<summary>UC-017〜UC-020 のシーケンス図（v0.2）</summary>

```mermaid
sequenceDiagram
    actor U as 作成者
    participant W as Web App
    participant A as api
    participant K as worker
    participant E as sandbox-edge
    participant L as LLMプロバイダー
    participant G as gateway
    participant GH as GitHub
    participant WP as Web Push
    participant D as DB

    U->>W: 「新しいエージェント」→「会話で作る」（SCR-014）
    W->>A: POST /api/v1/repos/{repoId}/agent-drafts（API-043）
    A->>D: agent_drafts INSERT(drafting)
    A-->>W: 201 下書き
    U->>W: やってほしいことを入力（SCR-015）
    W->>A: POST /api/v1/agent-drafts/{id}/messages（API-045 / SSE）
    A->>K: 設計アシスタントのジョブ
    K->>E: 内部関数（phase=design）
    E->>L: LLM呼び出し（BYOKのキー、routing の design）
    L-->>E: 応答
    E-->>K: { explanation, patch }
    K->>K: patch を適用、スキーマ検証 ＋ compose(ceilings, repoPolicy, draft)
    alt 違反なし
        K->>D: agent_drafts 更新（definition_yaml・last_validation・assistant_cost_usd）、usage_records INSERT(design)
        K-->>W: SSE explanation / patch_applied
    else 違反あり（1回だけ作り直させても通らない）
        K-->>W: SSE patch_rejected（理由）
    end
    U->>W: Canvas で編集（SCR-016）
    W->>A: PUT /api/v1/agent-drafts/{id}（API-046）
    A->>A: 検証 ＋ compose
    A-->>W: 200 errors / warnings / effective / locked / summary
    U->>W: 「試し実行」
    W->>A: POST /api/v1/agent-drafts/{id}/dry-runs（API-047）
    A->>D: agent_snapshots INSERT(source=draft)、tasks INSERT(queued, is_dry_run)
    Note over A,E: UC-007 と同じ経路（予算は min(per_task_usd, $1)）。Intent は simulated、メモリは破棄（UC-018）
    U->>W: 「公開する」→ 確認シート
    W->>A: POST /api/v1/agent-drafts/{id}/publish（API-048）
    A->>A: デフォルトブランチ HEAD のポリシーで再検証
    A->>G: POST /gw/v1/agent-config-prs
    G->>G: path がすべて .agent/ 配下かを確認（BR-28）
    G->>GH: ブランチ open-team/agent-config/... ・コミット・PR作成
    G-->>A: PR番号
    A->>D: agent_drafts → published(pr_number)、audit agent_config.pr_opened
    A-->>W: 200 PRのリンク
    GH->>A: POST /webhooks/github pull_request.opened / synchronize（.agent/** を変更。API-035）
    A->>D: webhook_deliveries INSERT、検証ジョブを登録
    K->>K: PR の head の定義を検証 ＋ compose
    K->>G: POST /gw/v1/repos/{repoId}/check-runs（open-team/agent-config）
    G->>GH: Check Run 作成（success / neutral / failure）
    alt マージされた
        GH-->>U: レビュー・マージ（GitHub 上。ブランチ保護が効く）
        GH->>A: POST /webhooks/github push（.agent/ に変更。API-035）
        A->>D: webhook_deliveries INSERT、定義の読み込みジョブを登録
        K->>G: GET /gw/v1/repos/{repoId}/files（.agent/agents/*.yaml・SKILL.md）
        G->>GH: デフォルトブランチ HEAD のファイルを取得
        G-->>K: ファイル
        K->>K: 検証 ＋ compose（ceilings_version を記録）
        K->>D: agent_snapshots INSERT(source=branch)、agents → active、<br/>agent_schedules を作り直す、agent_drafts → merged、audit agent.activated
        K->>WP: エージェント担当者と組織の owner へ通知
        WP-->>U: 「bug-fixer が有効になりました」
    else マージされずにクローズ（UC-019 4a）
        GH->>A: POST /webhooks/github pull_request.closed（merged = false）
        A->>D: agent_drafts → drafting（pr_number を last_pr_number に移す）
        Note over U,D: 下書きは再び編集・公開できる
    end
```

</details>

見てほしいところ：v0.2 では定義の正本がリポジトリで、PR のマージ（ブランチ保護が効く）で初めて有効になった。

## v0.2（置き換え済み）：試し実行での Intent の simulated 化

<details>
<summary>UC-018 のシーケンス図（v0.2）</summary>

```mermaid
sequenceDiagram
    participant S as agent-runner（Sandbox）
    participant E as sandbox-edge
    participant K as worker
    actor U as 作成者
    participant W as Web App
    participant A as api
    participant D as DB

    S->>E: POST /internal/v1/intents（API-039）
    E->>E: 差分をパース、ベースに適用、expectedTreeSha を計算
    E->>E: decide(intent)（実効ポリシーで通常どおり判定）
    E->>D: BEGIN、action_intents INSERT → simulated（decision は判定結果のまま）、<br/>tasks → completed(dry_run)、トークン失効、audit intent.proposed、COMMIT
    Note over E,D: approvals は作らない。Gateway の実行ジョブも登録しない（BR-24）
    E-->>S: 201 {decision, simulated: true}
    K->>S: サンドボックスを停止・破棄
    K->>K: リスク評価・差分要約（プレビュー用）
    U->>W: タスク詳細（SCR-005、試し実行の帯）
    W->>A: GET /api/v1/tasks/{id}（API-013）
    A-->>W: intent.preview（承認カードと同じ内容。承認の操作はできない）
```

</details>

見てほしいところ：試し実行の Intent は判定だけ通常どおり行い、承認も Gateway の実行も作らない（BR-24）。v0.5 で試し実行は「詳細設定」の機能（REQ-022、Could）として残る。
