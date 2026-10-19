# 10. シーケンス図：統制の基本（委任・承認・停止）
- 入口：[README](README.md) ／ 関連：[03](../03_use_cases/README.md)、[04](../04_functional_spec/README.md)、[09](../09_api/README.md)

> **3行で**
> 1. 開発エージェント（GitHub・PR）を題材に、委任 → 自律実行 → 承認 → 実行 → 検証の主要フローと、停止系（Breaker・Kill Switch・検証の不一致）の6枚を載せる。
> 2. 図の中身は v0.2 の記述のまま。`organizations` は旧称で、今の `workspaces` を指す（13 で改名）。
> 3. MCP の書き込みの流れは [sequences-mcp.md](sequences-mcp.md)。判定・Kill Switch・監査ログの仕組みは PR と共通。

## UC-001：サインイン・リポジトリ連携（認証）

フェーズ1。フェーズ0（単一ユーザー・ローカル）ではサインインを省略し、固定トークン（D-06）で画面を守る（13 §フェーズ0）。

```mermaid
sequenceDiagram
    actor U as 依頼者
    participant W as Web App
    participant A as api
    participant G as gateway
    participant GH as GitHub
    participant D as DB

    U->>W: 「GitHubでサインイン」（SCR-001）
    W->>A: GET /api/v1/auth/github/login（API-001）
    A-->>W: 302 GitHub認可URL（state Cookie）
    W->>GH: 認可
    GH-->>W: 302 /callback?code&state
    W->>A: GET /api/v1/auth/github/callback（API-002）
    A->>A: state を照合
    A->>GH: code → トークンを交換、GET /user
    A->>D: users を UPSERT、sessions を INSERT
    A-->>W: 302 /onboarding（Set-Cookie: ot_session）
    U->>GH: GitHub App をインストール（SCR-012 から）
    GH->>A: POST /webhooks/github installation.created（API-035）
    A->>A: 署名を検証
    A->>D: webhook_deliveries を INSERT、同期ジョブを登録
    Note over A,D: worker がジョブを処理
    A->>G: POST /gw/v1/installations/{id}/sync
    G->>GH: リポジトリの一覧、.agent/policy.yaml
    G->>D: organizations・memberships（owner）・repositories・policy_snapshots を INSERT
    W->>A: GET /api/v1/orgs（API-005）
    A-->>W: 200 組織の一覧
```
見てほしいところ：ユーザーのサインイン（API-002）と、GitHub App のインストール後の同期（worker → gateway）は別の流れ。GitHub の認証情報を扱うのは gateway だけ。

## UC-005 / UC-007：タスク委任と自律実行（主要フロー①）

```mermaid
sequenceDiagram
    actor U as 依頼者
    participant W as Web App
    participant A as api
    participant K as worker
    participant G as gateway
    participant S as agent-runner（Sandbox）
    participant E as sandbox-edge
    participant L as LLMプロバイダー
    participant D as DB

    U->>W: Issueを選んで「委任する」（SCR-003）
    W->>A: POST /api/v1/tasks（API-011）
    A->>D: BR-07 を検証（Kill Switch・ポリシー・キー・重複）
    A->>D: BEGIN、tasks INSERT(queued)、ジョブ登録、audit task.created、COMMIT
    A-->>W: 201 タスク
    W->>A: GET /api/v1/tasks/{id}/stream（API-015 / SSE）
    K->>D: ジョブを取得、同時実行数・日次予算を確認
    K->>D: tasks → provisioning
    K->>G: POST /gw/v1/repos/{repoId}/snapshots
    G-->>K: snapshotObjectPath
    K->>D: sandbox_token_hash を保存
    K->>S: Cloud Run Jobs 起動（TASK_ID, SANDBOX_TOKEN, INTERNAL_API_URL）
    S->>E: GET /internal/v1/task-context（API-036）
    E->>D: tasks → running
    E-->>S: コンテキスト＋署名つきURL
    loop investigate → plan → implement → test
        S->>E: POST /internal/v1/llm/messages（API-037）
        E->>D: BEGIN、tasks を FOR UPDATE（カウンタ・フラグ）
        E->>E: decide(llm_call)：予算・Breaker の事前判定
        E->>L: LLM呼び出し（BYOKのキーを復号）
        L-->>E: 応答（tool_call を含む）
        E->>E: decide(tool_call) を tool_call ごとに実行
        E->>D: usage_records・policy_decisions・task_events INSERT、カウンタ更新、COMMIT
        E-->>S: 応答＋governance[]
        S->>S: allow のツールだけを実行
        S->>E: POST /internal/v1/events（API-038）
        E-->>A: NOTIFY（task_events）
        A-->>W: SSE: tool_called / llm_called / budget_updated
    end
    S->>E: POST /internal/v1/intents（API-039）→ UC-009 へ
```
見てほしいところ：LLM 呼び出しの前後で sandbox-edge が `decide()` を実行し、`allow` のツールだけがサンドボックスで動く。判定・費用・イベントは1つのトランザクションで記録する。

## UC-009 / UC-010：承認・実行・検証（主要フロー②）

```mermaid
sequenceDiagram
    participant S as agent-runner
    participant E as sandbox-edge
    participant K as worker
    participant WP as Web Push
    actor AP as 承認者
    participant W as Web App
    participant A as api
    participant G as gateway
    participant GH as GitHub
    participant D as DB

    S->>E: POST /internal/v1/intents（diff, title, body）
    E->>E: 差分をパース、ベースに適用、expectedTreeSha を計算
    E->>E: decide(intent)：paths.deny・files_changed_max・autonomy.open_pr
    E->>D: BEGIN、action_intents INSERT(pending_approval)、approvals INSERT(pending)、<br/>tasks → awaiting_approval、トークン失効、audit intent.proposed / approval.requested、COMMIT
    E-->>S: 201 {decision: approve}
    K->>S: サンドボックスを停止・破棄
    K->>K: リスク評価（ルール）、差分要約（summarize モデル）
    K->>WP: 承認者へ通知
    WP-->>AP: 「承認待ち：owner/app #123」
    AP->>W: 通知をタップ → SCR-007
    W->>A: GET /api/v1/approvals/{id}（API-018）
    A-->>W: 承認カード（intentHash を含む）
    AP->>W: 「承認」→ 確認
    W->>A: POST /api/v1/approvals/{id}/decision {approve, intentHash}（API-019）
    A->>D: BEGIN、承認者・pending・期限・Kill Switch・intentHash を検証、<br/>approvals → approved、intents → approved、実行ジョブ登録、audit approval.decided、COMMIT
    A-->>W: 200
    K->>G: POST /gw/v1/intents/{id}/execute
    G->>D: BEGIN、intent を FOR UPDATE、approved・Kill Switch 未発動・タスク未終了を確認、→ executing、COMMIT
    G->>GH: インストールトークン発行（対象リポジトリ・最小権限）
    G->>GH: blob / tree / commit 作成（tree SHA = expectedTreeSha を確認）
    G->>GH: refs/heads/open-team/task-{id} 作成
    G->>GH: PR作成（draft=false）
    G->>D: intents → executed（pr_number）、audit action.executed
    G->>GH: GET PR（head の tree SHA）
    G->>G: expectedTreeSha と比較
    G->>D: intents → verified、tasks → succeeded、audit action.verified
    K->>WP: 依頼者へ「PRを作成しました」
```
見てほしいところ：承認は `intentHash` に紐づく（ADR-005）。Gateway は実行前に状態と Kill Switch を確かめ直し、PR の tree SHA を `expectedTreeSha` と比べて検証する。

## UC-008：Breaker 作動による自動停止（エラー時の代表例①）

```mermaid
sequenceDiagram
    participant S as agent-runner
    participant E as sandbox-edge
    participant K as worker
    participant WP as Web Push
    participant D as DB

    S->>E: POST /internal/v1/llm/messages
    E->>D: tasks を FOR UPDATE（repeat_count = 4）
    E->>E: LLM呼び出し → tool_call(read_file src/a.ts)（直前と同じ）
    E->>E: decide(tool_call)：repeat_count+1 ≥ same_action_repeat(5) → halt
    E->>D: BEGIN、policy_decisions INSERT(halt, breaker_tripped, breakers.same_action_repeat)、<br/>tasks → halted(breaker_tripped)、トークン失効、<br/>audit breaker.tripped、停止ジョブ登録、COMMIT
    E-->>S: 200 governance[{decision: halt}]
    S->>S: ただちに終了
    K->>K: SandboxProvider.stop（念のため）
    K->>WP: 依頼者へ「停止しました（Breaker作動）」
    Note over S,E: 以降、同じトークンでの呼び出しは 401 / 409 TASK_HALTED
```
見てほしいところ：停止の判断は決定論的な `decide()` が行い、停止・トークン失効・監査ログを1つのトランザクションで記録する。

## UC-012：Kill Switch（エラー時の代表例②）

```mermaid
sequenceDiagram
    actor U as 依頼者（maintainer）
    participant W as Web App
    participant A as api
    participant K as worker
    participant S as agent-runner（複数）
    participant E as sandbox-edge
    participant G as gateway
    participant D as DB

    U->>W: ■ KILL →「停止する」（SCR-013）
    W->>A: POST /api/v1/orgs/{orgId}/kill-switch（API-020）
    A->>D: BEGIN、organizations.kill_switch_engaged = true、<br/>未終了の tasks → halted(kill_switch)、approvals / intents → expired、<br/>全トークン失効、停止ジョブ登録、audit killswitch.engaged、COMMIT
    A-->>W: 200 {engaged: true, affectedTaskIds}
    par 並行して
        K->>S: SandboxProvider.stop（全タスク）
    and
        S->>E: POST /internal/v1/llm/messages（停止前の呼び出し）
        E->>D: flags.killSwitchEngaged = true
        E-->>S: 409 TASK_HALTED
    and
        G->>D: execute の前提確認で kill_switch_engaged = true
        G-->>G: 実行しない（Intent → failed: precondition_failed）
    end
    K->>D: 停止を確認 → metrics killswitch_stop_latency_seconds
    K->>K: 組織の全メンバーへ通知
```
見てほしいところ：Kill Switch は DB のフラグを先に立て、サンドボックスの停止・LLM 呼び出しの拒否・Gateway の実行拒否が並行して効く。`organizations.kill_switch_engaged` は今の `workspaces.kill_switch_engaged`。

## UC-010 E3：検証の不一致（エラー時の代表例③）

```mermaid
sequenceDiagram
    participant G as gateway
    participant GH as GitHub
    participant D as DB
    participant K as worker

    G->>GH: PR作成（executed）
    G->>GH: GET PR → head の tree SHA
    G->>G: tree SHA ≠ expectedTreeSha（例：作成直後に誰かがブランチへpush）
    G->>D: intents → failed(verify_mismatch)、tasks → failed、audit action.failed
    G->>K: 通知ジョブ登録
    K->>K: 依頼者と owner に「PRの検証に失敗しました」
```
見てほしいところ：PR は作成済み（`executed`）でも、tree SHA が一致しなければ `failed`（`verify_mismatch`）にする。
