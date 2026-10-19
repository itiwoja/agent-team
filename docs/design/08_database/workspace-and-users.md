# 08. DB設計：ワークスペース・ユーザー・リポジトリ
- 親：[README.md](README.md) ／ 版数：v0.6（2026-10-01）

> **3行で**
> 1. ワークスペース（旧称：組織。TBL-002）と、ユーザー・メンバーシップ・セッション・通知の購読・LLM のキー・Webhook の受信記録を定義する。
> 2. リポジトリ（TBL-004）とポリシースナップショット（TBL-005）は、開発エージェント用の追加の上限として残る（13 BR-43）。
> 3. 改名の範囲（列名・GitHub 関連列）は [Q-62](README.md#-判断してほしいこと)、フェーズ0でもテーブルを作り、利用者1人・ワークスペース1つの行を初期投入する（[D-05](../decisions.md#d-05)）。

---

## TBL-001：users（ユーザー）
GitHub のユーザーと、その OAuth トークン。主なカラム：`id`, `github_user_id`, `login`。フェーズ0から（D-05）。フェーズ0は GitHub を使わない場合があるため `github_user_id` は NULL 可にし、フェーズ1のサインインで埋める。

<details>
<summary>カラム定義（14列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| github_user_id | bigint | NO | | UQ | GitHubのユーザーID（変わらない） |
| login | text | NO | | | GitHubのログイン名（変わることがある。ログインのたびに更新） |
| name | text | YES | | | 表示名 |
| avatar_url | text | YES | | | |
| email | text | YES | | | 公開されている場合だけ |
| locale | text | NO | 'ja' | | `ja` / `en` |
| github_token_ciphertext | bytea | YES | | | user-to-server のアクセストークン（暗号化済み） |
| github_refresh_token_ciphertext | bytea | YES | | | リフレッシュトークン（暗号化済み） |
| github_token_dek | bytea | YES | | | KMSで暗号化したDEK |
| github_token_expires_at | timestamptz | YES | | | |
| deleted_at | timestamptz | YES | | | 退会（仮名化した日時） |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- インデックス：`github_user_id`（UQ）、`login`
- 想定レコード数：500（ベータ）、月に50ずつ増える

## TBL-002：workspaces（ワークスペース。旧称 organizations）
すべてのエージェントの上限となる単位。Kill Switch とワークスペースの設定を持つ。フェーズ0。
- v0.4 で `organizations` から改名した（13 A-78）。GitHub App のインストール単位ではなくなり、個人のワークスペースはサインイン時に自動で作る。GitHub はワークスペースにつなぐ連携先の1つになる（13 §概念モデル）。
- 下のカラム定義は v0.2（organizations）のまま。GitHub 関連の列（`github_installation_id` が NOT NULL など）と改名の範囲は Q-62。ポリシーは別テーブル（TBL-026）。

<details>
<summary>カラム定義（17列。v0.2 の organizations のもの）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| github_installation_id | bigint | NO | | UQ | |
| github_account_id | bigint | NO | | | インストール先のアカウントID |
| github_account_login | text | NO | | | 例：`owner` |
| account_type | text | NO | | | `User` / `Organization` |
| status | text | NO | 'active' | | `active` / `suspended` / `disconnected` |
| kill_switch_engaged | boolean | NO | false | | |
| kill_switch_engaged_at | timestamptz | YES | | | |
| kill_switch_engaged_by | uuid | YES | | FK→users | |
| kill_switch_reason | text | YES | | | 発動・解除の理由（最新のもの） |
| timezone | text | NO | 'UTC' | | IANAのタイムゾーン名。日次予算の区切りに使う |
| store_transcripts | boolean | NO | true | | プロンプトと応答の全文を保存するか（A-15） |
| max_concurrent_tasks | integer | NO | 3 | | BR-08 |
| audit_seq | bigint | NO | 0 | | 監査ログの最新の連番（採番時に行をロックする） |
| audit_last_hash | bytea | NO | '\x00…'（32バイト） | | 監査ログの最新のハッシュ |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- 制約：`status IN ('active','suspended','disconnected')`、`account_type IN ('User','Organization')`
- 想定レコード数：100（ベータ）

## TBL-003：memberships（メンバーシップ）
ユーザーとワークスペースの関係とロール。主なカラム：`organization_id`, `user_id`, `role`。フェーズ0から（初期投入の1行、`role = owner`。D-05）。

<details>
<summary>カラム定義（6列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations（→ workspaces。Q-62） | |
| user_id | uuid | NO | | FK→users | |
| role | text | NO | 'viewer' | | `owner` / `maintainer` / `viewer` |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(organization_id, user_id)` UQ、`user_id`
- 制約：`role IN ('owner','maintainer','viewer')`
- 想定レコード数：500〜1,000

## TBL-004：repositories（リポジトリ）
連携しているリポジトリ。開発エージェントだけが使う（13）。フェーズ1（開発テンプレートはフェーズ1。13 §フェーズ計画）。

<details>
<summary>カラム定義（10列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| github_repo_id | bigint | NO | | UQ | |
| full_name | text | NO | | | 例：`owner/app` |
| default_branch | text | NO | | | |
| private | boolean | NO | | | |
| status | text | NO | 'active' | | `active` / `disconnected` |
| current_policy_snapshot_id | uuid | YES | | FK→policy_snapshots | 最新のスナップショット |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- インデックス：`github_repo_id`（UQ）、`organization_id`
- 想定レコード数：500

## TBL-005：policy_snapshots（ポリシースナップショット）
リポジトリの `.agent/policy.yaml` を検証・正規化したもの（変更しない）。v0.4 以降は開発エージェントにだけ追加でかかる上限（13 BR-43）。フェーズ1。

<details>
<summary>カラム定義（14列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| repository_id | uuid | NO | | FK→repositories | |
| commit_sha | text | NO | | | 読み込んだコミット |
| source | text | NO | | | `file`（ファイルあり） / `default`（既定ポリシー） |
| status | text | NO | | | `valid` / `invalid` |
| policy | jsonb | YES | | | 正規化したポリシー（invalid の場合は NULL） |
| routing | jsonb | YES | | | 正規化した routing |
| policy_hash | text | YES | | | 正規化したポリシーと routing の SHA-256（16進） |
| raw_policy | text | YES | | | 元のYAML（最大64KB） |
| raw_routing | text | YES | | | |
| errors | jsonb | NO | '[]' | | `[{file, line, path, code, message}]` |
| warnings | jsonb | NO | '[]' | | 同上 |
| created_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(repository_id, commit_sha)` UQ
- 制約：変更しない（UPDATE しない）。`status='valid'` なら `policy` と `policy_hash` は NOT NULL（CHECK制約）
- 想定レコード数：月に約1,000

## TBL-013：llm_credentials（LLMの認証情報）
BYOK のキー（エンベロープ暗号化済み。[ADR-010](../adr/ADR-010-byok-envelope-encryption.md)）。フェーズ1（フェーズ0は `.env` で渡す。13 §フェーズ0）。

<details>
<summary>カラム定義（11列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| provider | text | NO | | | `anthropic` / `openai` / `openrouter` |
| ciphertext | bytea | NO | | | AES-256-GCM で暗号化したキー（nonce とタグを含む） |
| encrypted_dek | bytea | NO | | | KMSで暗号化したDEK |
| kek_version | text | NO | | | KMSの鍵バージョン |
| last4 | text | NO | | | 末尾4文字 |
| verified_at | timestamptz | NO | | | 疎通確認の日時 |
| created_by | uuid | NO | | FK→users | |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(organization_id, provider)` UQ

## TBL-014：push_subscriptions（通知の購読）
Web Push の購読情報。プッシュ通知はフェーズ0から使う（13 §フェーズ計画）。

<details>
<summary>カラム定義（8列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| user_id | uuid | NO | | FK→users | |
| endpoint | text | NO | | UQ | |
| p256dh | text | NO | | | |
| auth | text | NO | | | |
| device_label | text | YES | | | 例：`iPhone (Safari)` |
| created_at | timestamptz | NO | now() | | |
| last_used_at | timestamptz | YES | | | |

</details>

- インデックス：`endpoint`（UQ）、`user_id`
- 備考：ワークスペースに属さないため、RLS の対象外（`user_id` で制限する）

## TBL-016：sessions（セッション）
ログインセッション。フェーズ1（フェーズ0はサインインを省略する。13 §フェーズ0）。

<details>
<summary>カラム定義（10列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| user_id | uuid | NO | | FK→users | |
| token_hash | bytea | NO | | UQ | Cookieの値の SHA-256 |
| csrf_token | text | NO | | | |
| user_agent | text | YES | | | |
| ip | inet | YES | | | |
| created_at | timestamptz | NO | now() | | |
| last_seen_at | timestamptz | NO | now() | | |
| expires_at | timestamptz | NO | | | 最後のアクセスから30日 |
| revoked_at | timestamptz | YES | | | ログアウト |

</details>

- インデックス：`token_hash`（UQ）、`user_id`、`expires_at`
- 備考：RLS の対象外

## TBL-017：webhook_deliveries（Webhook受信記録）
冪等処理のための GitHub の配信ID。フェーズ1（GitHub 連携とともに）。

<details>
<summary>カラム定義（7列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| delivery_id | text | NO | | PK | `X-GitHub-Delivery` |
| event | text | NO | | | 例：`issues` |
| action | text | YES | | | 例：`labeled` |
| organization_id | uuid | YES | | FK→organizations | |
| status | text | NO | 'received' | | `received` / `processed` / `ignored` / `failed` |
| received_at | timestamptz | NO | now() | | |
| processed_at | timestamptz | YES | | | |

</details>

- 備考：RLS の対象外（システムだけが使う）
