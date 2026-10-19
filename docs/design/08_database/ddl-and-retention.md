# 08. DB設計：DDL・RLS・データ保持・前提
- 親：[README.md](README.md) ／ 版数：v0.6（2026-10-01）

> **3行で**
> 1. DDL は抜粋（CHECK 制約・部分一意インデックス・変更禁止のトリガー・RLS）だけを載せる。全テーブルの DDL は作らない。
> 2. 監査ログは追記のみ（アプリのロールに UPDATE・DELETE を与えない）。テナント分離は RLS（フェーズ0は実装しない。13 §フェーズ0）。
> 3. 保持期限を過ぎたデータは日次のバッチで物理削除する。v0.4〜0.6 の新テーブルの保持期間は多くが未設計（Q-69）。

---

## DDL（抜粋）
v0.2 の DDL に、v0.6 の Intent の状態（`unknown_outcome`）だけを反映した。v0.4〜0.6 のその他の変更（新テーブル・列の追加・`action_intents` の UQ の削除）の DDL は、カラム未設計のため書かない（Q-65〜68）。

<details>
<summary>DDL 抜粋（tasks・action_intents・agents・agent_snapshots・agent_drafts・agent_schedules・agent_memories・audit_logs・RLS）</summary>

```sql
-- 未完了タスクの重複を防ぐ（TASK_ALREADY_ACTIVE。BR-29：エージェント単位）
CREATE UNIQUE INDEX tasks_active_agent_issue_uq
  ON tasks (agent_id, issue_number)
  WHERE status IN ('queued','provisioning','running','awaiting_approval','executing')
    AND issue_number IS NOT NULL
    AND NOT is_dry_run;

-- ステータスの値を制限する（v0.2 で completed を追加）
ALTER TABLE tasks ADD CONSTRAINT tasks_status_chk CHECK (status IN
  ('queued','provisioning','running','awaiting_approval','executing',
   'succeeded','completed','rejected','failed','cancelled','halted'));

-- Issue か指示文のどちらかが必須（v0.2）
ALTER TABLE tasks ADD CONSTRAINT tasks_input_chk CHECK (
  kind = 'policy_change' OR issue_number IS NOT NULL OR prompt IS NOT NULL);

-- 試し実行は下書きに紐づき、エージェントには紐づかない（v0.2。下書きの廃止は Q-67）
ALTER TABLE tasks ADD CONSTRAINT tasks_dry_run_chk CHECK (
  is_dry_run = (trigger_type = 'dry_run')
  AND (NOT is_dry_run OR (agent_draft_id IS NOT NULL AND agent_id IS NULL))
  AND (is_dry_run OR agent_id IS NOT NULL));

ALTER TABLE tasks ADD CONSTRAINT tasks_trigger_type_chk CHECK (trigger_type IN
  ('manual','github_label','github_mention','schedule','dry_run','trust_proposal'));

-- prompt は Issue なしのタスクだけ。Issue への追加の指示は instructions（v0.2）
ALTER TABLE tasks ADD CONSTRAINT tasks_prompt_chk CHECK (
  (issue_number IS NULL OR prompt IS NULL)
  AND (prompt IS NULL OR char_length(prompt) <= 2000)
  AND (instructions IS NULL OR char_length(instructions) <= 2000));

-- halt_reason（v0.2 で agent_disabled を追加）
ALTER TABLE tasks ADD CONSTRAINT tasks_halt_reason_chk CHECK (halt_reason IS NULL OR halt_reason IN
  ('budget_exceeded','breaker_tripped','timeout','kill_switch','policy_violation',
   'approval_expired','installation_removed','agent_disabled'));

-- Intent の状態（v0.2 で simulated、v0.6 で unknown_outcome を追加。15）
ALTER TABLE action_intents ADD CONSTRAINT action_intents_status_chk CHECK (status IN
  ('proposed','denied','pending_approval','approved','rejected','expired',
   'executing','executed','verified','failed','simulated','unknown_outcome'));

-- エージェント（v0.2）
CREATE UNIQUE INDEX agents_repo_slug_uq ON agents (repository_id, slug);
ALTER TABLE agents ADD CONSTRAINT agents_status_chk CHECK (status IN
  ('active','invalid','disabled','removed'));

ALTER TABLE agent_snapshots ADD CONSTRAINT agent_snapshots_valid_chk CHECK (
  status <> 'valid' OR (effective_policy IS NOT NULL AND effective_policy_hash IS NOT NULL));
ALTER TABLE agent_snapshots ADD CONSTRAINT agent_snapshots_source_chk CHECK (
  (source = 'branch' AND agent_id IS NOT NULL AND commit_sha IS NOT NULL)
  OR (source = 'draft' AND agent_draft_id IS NOT NULL)
  OR (source = 'builtin' AND agent_id IS NOT NULL AND commit_sha IS NULL));
CREATE UNIQUE INDEX agent_snapshots_branch_uq
  ON agent_snapshots (agent_id, commit_sha, policy_snapshot_id, ceilings_version)
  WHERE source = 'branch';
CREATE UNIQUE INDEX agent_snapshots_builtin_uq
  ON agent_snapshots (agent_id, policy_snapshot_id, ceilings_version)
  WHERE source = 'builtin';

-- 下書き：公開中は PR 番号を持ち、drafting に戻したら last_pr_number に移す（v0.2。v0.5 で廃止）
ALTER TABLE agent_drafts ADD CONSTRAINT agent_drafts_pr_chk CHECK (
  (status NOT IN ('published','merged') OR pr_number IS NOT NULL)
  AND (status <> 'drafting' OR pr_number IS NULL));

-- エージェントスナップショット：変更しない
CREATE FUNCTION forbid_snapshot_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_snapshots is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_snapshots_no_update BEFORE UPDATE ON agent_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_snapshot_update();

CREATE UNIQUE INDEX agent_schedules_trigger_uq ON agent_schedules (agent_id, trigger_index);
CREATE INDEX agent_schedules_due_idx ON agent_schedules (next_run_at);

CREATE INDEX agent_memories_list_idx
  ON agent_memories (agent_id, status, created_at DESC);

-- メモリの出どころ：タスクの削除で NULL にし、表示用の文字列を残す（v0.2）
ALTER TABLE agent_memories
  ADD CONSTRAINT agent_memories_source_task_fk FOREIGN KEY (source_task_id)
  REFERENCES tasks (id) ON DELETE SET NULL;

-- 監査ログ：追記のみ
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW WHEN (current_user <> 'ot_retention')
  EXECUTE FUNCTION forbid_audit_mutation();

REVOKE UPDATE, DELETE ON audit_logs FROM ot_app;

-- テナント分離（全業務テーブルに同じポリシーをかける）
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tasks
  USING (organization_id = current_setting('app.org_id')::uuid);

-- v0.2 で追加したテーブルにも同じポリシーをかける
-- （agents、agent_snapshots、agent_schedules、agent_drafts、agent_memories）
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (organization_id = current_setting('app.org_id')::uuid);
-- 以下、agent_snapshots・agent_schedules・agent_drafts・agent_memories も同じ
```

</details>

- 15 で決めた CHECK：`action_intents` の PR 専用の列は `action_type = 'open_pr'` のときだけ NOT NULL（[tasks-and-intents.md](tasks-and-intents.md)）。DDL の文面は未作成。
- `action_intents.task_id` の UQ は v0.6 で外した（15）。v0.2 の DDL に UQ の文はないが、列定義の「UQ」を削除した。

## RLS の補足
- TBL-018〜022 はすべて `organization_id` を持ち、上記の `tenant_isolation` をかける（v0.2）。TBL-023〜025 は 14 の定義に `organization_id` がない（Q-66）。
- スケジューラー（worker の毎分の処理）はワークスペースをまたいで `agent_schedules` を読むため、専用のロール（`ot_scheduler`。`BYPASSRLS`、`agent_schedules` の SELECT・UPDATE と、`agents`・`tasks` の SELECT だけ）を使い、タスクの作成はワークスペースごとに `app.org_id` を設定してから行う。
- フェーズ0では RLS・マルチテナントを実装しない（設計は残す。13 §フェーズ0）。

## データ保持・削除ポリシー

<details>
<summary>対象ごとの保持期間と削除方法（22行）</summary>

| 対象 | 保持期間 | 削除方法 | 根拠 |
|---|---|---|---|
| audit_logs | 1年 | 日次のバッチで、メンテナンス用のロールが削除する。削除する前に、その範囲のチェックポイントが保存されていることを確認する | NFR-035 |
| tasks、task_events、action_intents（diff を含む）、approvals、policy_decisions | 90日（終了日時から）。試し実行のタスクも同じ | 日次のバッチで物理削除 | NFR-035 |
| tasks.report | タスクと同じ（90日） | タスクと一緒に削除 | NFR-035 |
| usage_records | 13か月（前年同月との比較のため） | 日次のバッチ | A-28 |
| policy_snapshots | 参照しているタスク・エージェントスナップショットがなくなり、かつ最新でなくなってから90日 | 日次のバッチ | — |
| agents | 削除しない（`removed` でも残す）。リポジトリの連携解除後は、ワークスペースのデータの扱いに従う（Q-61） | — | 12 TBL-018 |
| agent_snapshots | 変更しない。`source='branch'` / `'builtin'`：参照しているタスクがなくなり、かつ `agents.current_snapshot_id` でなくなってから90日。`source='draft'`：下書きの削除と一緒に削除（参照しているタスクがある間は残す） | 日次のバッチ（メンテナンス用のロール。UPDATE はしない） | 12 TBL-019 |
| agent_schedules | エージェントが `active` でなくなったとき（`disabled` を除く）に削除 | UC-020 の読み込み処理 | — |
| agent_drafts（v0.5 で廃止） | `drafting` は最終更新から90日で `discarded`。`merged` / `discarded` の行は、その90日後に物理削除（`published` は PR の結果が出るまで残す） | 日次のバッチ | 12 TBL-021 |
| 下書きの会話の全文（GCS、`conversation_object_path`。v0.5 で廃止） | 30日 | GCSのライフサイクルルール（期限後は `conversation_object_path` を NULL にする） | 12 TBL-021 |
| agent_memories | `pending` / `active`：保持期限なし（削除・上限超過まで。書き込んだタスクが先に削除されても `source_task_ref` で出どころを示す）。`discarded` / `expired` / `deleted`：状態が変わってから30日で物理削除（内容を残さないため） | 日次のバッチ | 12 FR-031、ADR-014 |
| agent_messages（v0.5） | 90日。それより古い会話は要約を残して消す | （未設計。Q-69） | 14 A-80 |
| agent_jobs・agent_config_changes（v0.5）、workspace_policies・connectors・connector_tools・profiles・reports（v0.4） | 未設計 | — | Q-69 |
| プロンプトと応答の全文（GCS） | 30日 | GCSのライフサイクルルール | A-15 |
| リポジトリのtarball（GCS） | タスク終了から24時間 | 1時間ごとのバッチ（FR-007） | NFR-035 |
| 監査ログのチェックポイント（GCS） | 1年（保持ロック） | GCSの保持ポリシー | NFR-028 |
| sessions | 失効から7日 | 日次のバッチ | — |
| webhook_deliveries | 30日 | 日次のバッチ | — |
| users（退会） | 申請から30日以内に仮名化（login・name・email・avatar_url・トークンを消去） | 退会処理 | NFR-045 |

</details>

## 前提・仮定（08 で置いたもの）

| ID | 仮定 |
|---|---|
| A-28 | usage_records は13か月保持する。 |
| A-29 | 差分（diff）は、5MBまでならDBの `text`（TOAST）に保存する。 |
| A-30 | 廃止（v0.6、→ 15 A-85）。旧：MVPでは1タスクにつきIntentは1件（`action_intents.task_id` を一意）。試し実行の `simulated` の Intent も同じ。 |
| A-55 | 12 の DB 定義（TBL-018〜022、tasks の変更）を正とする。08 で追加したのは、インデックス・CHECK制約・想定レコード数・保持期間・RLS・マイグレーション（`trigger_type`・`prompt` / `instructions`・`completed`・usage_records・既定エージェントなどの列と値は 12 v0.2 で確定）。 |
| A-56 | 想定レコード数は、ベータの規模（組織100、リポジトリ500）で、リポジトリあたり平均2エージェントとして見積もった（v0.4 の「最初の到達点はフェーズ0の単一ユーザー」より前の見積もり）。 |
| A-57 | スケジュールの重複判定（BR-29）のために `agent_schedules.last_task_id` を持ち、行を作り直すときは `cron`・`timezone`・`prompt` が同じなら引き継ぐ。 |
| A-58 | `action_intents.self_review` の形は `{model, rounds[], unresolved[]}` とする（12 は jsonb であることだけを定める）。 |
| A-59 | 既定エージェントの組み込みスナップショット（`source = 'builtin'`）は、`commit_sha` と `raw_definition` を NULL にし、ポリシースナップショットと Hard Ceiling の版ごとに1件とする。 |
| A-60 | API-058 で破棄できるのは `drafting` の下書きだけとする（`published` は公開PRのクローズで `drafting` に戻ってから。open-team からPRを閉じる書き込みは増やさない）。 |

他の文書で置いた、DB に効く仮定：A-34・A-35（12）、A-76・A-78（13）、A-80・A-81（14）、A-85・A-86（15）。本文の該当箇所で参照している。
