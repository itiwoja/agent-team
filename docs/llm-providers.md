# LLMプロバイダーの設定

Makase の担当編成・受け渡し・ツールの権限・承認・予算判定は共通です。LLMの接続先はサーバー起動時の設定で切り替えます。モデルが変わっても同じ業務フローを使えますが、生成品質・速度・文章・成功率が同一になる保証はありません。

| LLM_PROVIDER | API | キーの環境変数 |
|---|---|---|
| `gemini`（既定） | Gemini generateContent | `GEMINI_API_KEY` |
| `anthropic`（Claude） | Claude Messages（`https://api.anthropic.com/v1/messages` 固定） | `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek Chat Completions（`https://api.deepseek.com` 固定） | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter Chat Completions（`https://openrouter.ai/api/v1` 固定） | `OPENROUTER_API_KEY` |
| `openai` | OpenAI Chat Completions（`https://api.openai.com/v1` 固定） | `OPENAI_API_KEY` |
| `xai` | xAI（Grok）（`https://api.x.ai/v1` 固定） | `XAI_API_KEY` |
| `groq` | Groq（`https://api.groq.com/openai/v1` 固定） | `GROQ_API_KEY` |
| `mistral` | Mistral（`https://api.mistral.ai/v1` 固定） | `MISTRAL_API_KEY` |
| `together` | Together AI（`https://api.together.xyz/v1` 固定） | `TOGETHER_API_KEY` |
| `fireworks` | Fireworks AI（`https://api.fireworks.ai/inference/v1` 固定） | `FIREWORKS_API_KEY` |
| `cerebras` | Cerebras（`https://api.cerebras.ai/v1` 固定） | `CEREBRAS_API_KEY` |
| `moonshot` | Moonshot（Kimi）（`https://api.moonshot.ai/v1` 固定） | `MOONSHOT_API_KEY` |
| `zai` | Z.ai（GLM）（`https://api.z.ai/api/paas/v4` 固定） | `ZAI_API_KEY` |
| `qwen` | Alibaba Cloud Model Studio（Qwen、国際版）（`https://dashscope-intl.aliyuncs.com/compatible-mode/v1` 固定） | `DASHSCOPE_API_KEY` |
| `custom` | 上にない OpenAI 互換 API（`LLM_BASE_URL` で指定） | `LLM_API_KEY` |

名前のある提供元の接続先は固定です（キーの送り先を限るため。`LLM_BASE_URL` を設定しても無視します）。一覧にない API キーは `custom` で使えます。`openai-compatible` は `custom` に置き換えました。

### 一覧にない API（custom）

OpenAI 互換の Chat Completions（`POST {LLM_BASE_URL}/chat/completions`、`Authorization: Bearer`）を受ける API なら、キーの種類を問わず使えます。ローカルの Ollama・LM Studio・vLLM なども対象です。

```dotenv
LLM_PROVIDER=custom
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=
LLM_MODEL_AGENT=YOUR_MODEL_ID
LLM_MODELS_JSON={"YOUR_MODEL_ID":{"inputPerMTokMicroUsd":1000000,"outputPerMTokMicroUsd":2000000,"tools":true,"structuredOutput":"tool","temperature":true,"reasoningEffort":false,"maxOutputTokens":8192,"contextWindow":128000}}
```

- `LLM_BASE_URL` は `https://` のみ。手元のサーバー（`localhost`・`127.0.0.1`・`[::1]`）だけ `http://` も使えます。ユーザー名・パスワード・クエリ（`?key=…`）・`#` を含む URL は拒否します（キーを URL に混ぜないため）。末尾の `/` は外します。
- キーを使わないローカルサーバーでも `LLM_API_KEY` は必須です。任意のダミー値を入れてください。
- 接続先は運用者がサーバーの設定で決めます。キーは指定した接続先に送られるため、信頼できる接続先だけを設定してください。
- Gemini 以外で OpenAI 互換ではない独自形式の API（Cohere の独自 API など）は対象外です。各社が OpenAI 互換の入口を用意していればそちらを指定してください。

既存のGemini設定は引き続き使えます。Gemini以外のキーを `GEMINI_API_KEY` に入れないでください。選択プロバイダーのキーだけを使用します。キーはブラウザや作業場に渡しません。ログは既知のキー・APIキーパターン・認証ヘッダーをマスクします。APIエラー本文はプロンプトやキーを含み得るため表示しません。

## Gemini

```dotenv
LLM_PROVIDER=gemini
GEMINI_API_KEY=
# 従来の GEMINI_MODEL_AGENT / GEMINI_MODEL_PLANNER も有効
# LLM_MODEL_AGENT / LLM_MODEL_PLANNER があればそちらを優先
```

モデル省略時は従来の既定値です。既存の料金表にないGeminiモデルは拒否します。料金表の更新なしで未知モデルを無料扱いすることはありません。

## Claude と OpenAI 互換の提供元

`LLM_MODEL_AGENT` は必須。`LLM_MODEL_PLANNER` を省略すると同じモデルを使います。モデルIDはAPIが受け付ける正確なIDです。モデル名の前方一致や他社の価格表へのフォールバックはしません。比較用モデルは `LLM_MODELS_COMPARE` にカンマ区切りで指定できます。

**次のモデル名と料金は形式を示す架空の値です。実行前に利用先の公式仕様・料金で置き換えてください。** キーを作成・設定する操作をこの資料は自動実行しません。

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
LLM_MODEL_AGENT=YOUR_MODEL_ID
LLM_MODEL_PLANNER=YOUR_MODEL_ID
LLM_MODELS_JSON={"YOUR_MODEL_ID":{"inputPerMTokMicroUsd":2000000,"outputPerMTokMicroUsd":10000000,"tools":true,"structuredOutput":"tool","temperature":true,"reasoningEffort":false,"maxOutputTokens":8192,"contextWindow":200000}}
```

DeepSeek・OpenRouter などの OpenAI 互換の提供元（`custom` を含む）は、キーと対応モデルID・プロファイルを設定します。どれも Chat Completions 形式で、上限は `max_tokens` で送ります（`tokenLimitParameter` の既定）。OpenAI の推論モデルなど `max_completion_tokens` を求めるモデルは、プロファイルで `"tokenLimitParameter":"max_completion_tokens"` を明示してください。下の DeepSeek・OpenRouter 以外も `LLM_PROVIDER` とキーの名前を表のとおりに替えれば同じ形で設定できます。

```dotenv
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=
LLM_MODEL_AGENT=YOUR_MODEL_ID
LLM_MODEL_PLANNER=YOUR_MODEL_ID
LLM_MODELS_JSON={"YOUR_MODEL_ID":{"inputPerMTokMicroUsd":1000000,"outputPerMTokMicroUsd":2000000,"tools":true,"structuredOutput":"tool","temperature":true,"reasoningEffort":false,"maxOutputTokens":8192,"contextWindow":128000}}
```

```dotenv
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
LLM_MODEL_AGENT=vendor/YOUR_MODEL_ID
LLM_MODEL_PLANNER=vendor/YOUR_MODEL_ID
LLM_MODELS_JSON={"vendor/YOUR_MODEL_ID":{"inputPerMTokMicroUsd":2000000,"outputPerMTokMicroUsd":10000000,"tools":true,"structuredOutput":"tool","temperature":true,"reasoningEffort":false,"maxOutputTokens":8192,"contextWindow":200000}}
```

上の DeepSeek・OpenRouter の値も架空の例です。モデルIDは各サービスが受け付ける正確な文字列（OpenRouter は `ベンダー/モデル` 形式）にし、料金は公式の単価で置き換えてください。

OpenAI互換の提供元は、表の固定の接続先（`custom` は `LLM_BASE_URL`）の `/chat/completions` を呼びます。Claude は `https://api.anthropic.com/v1/messages` を呼びます。リダイレクトには追従しません。

## モデルプロファイル

### ローカルでClaudeを試す最小設定

リポジトリ直下の `.env` に以下を設定します。既存項目は保持し、キーをチャット・録画・Gitに含めないでください。

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=ここに本人が既存キーを入力
LLM_MODEL_AGENT=claude-haiku-5-5
LLM_MODEL_PLANNER=claude-haiku-5-5
LLM_MODELS_JSON={"claude-haiku-5-5":{"inputPerMTokMicroUsd":500000,"outputPerMTokMicroUsd":2500000,"tools":true,"structuredOutput":"tool","temperature":false,"anthropicMode":"haiku55-no-thinking","reasoningEffort":false,"maxOutputTokens":128000,"contextWindow":1000000}}
# LLM_SESSION_BUDGET_MICRO_USD=承認された正の整数を実行前に設定
```

Haiku 5.5は2026-10-19確認の[公式モデル資料](https://platform.claude.com/docs/en/models/haiku-5-5/overview)で固定ID claude-haiku-5-5、1M context / 128K output。通常料金は入力10万トークン以下で入力Haiku 4.5は2026-10-19確認の[公式モデル資料](https://platform.claude.com/docs/en/models/haiku-4-5/overview)でActive (legacy)、通常入力$1/100万・出力$5/100万、200K context / 64K output。拡張思考を要求しない設定で試します。最新モデルの推奨という意味ではなく、このアダプターの通常Messages用の具体例です。契約・アカウントの利用可否は実API未検証です。[公式料金](https://platform.claude.com/docs/en/about-claude/pricing)の変更時は更新が必要です。.10・出力Haiku 4.5は2026-10-19確認の[公式モデル資料](https://platform.claude.com/docs/en/models/haiku-4-5/overview)でActive (legacy)、通常入力$1/100万・出力$5/100万、200K context / 64K output。拡張思考を要求しない設定で試します。最新モデルの推奨という意味ではなく、このアダプターの通常Messages用の具体例です。契約・アカウントの利用可否は実API未検証です。[公式料金](https://platform.claude.com/docs/en/about-claude/pricing)の変更時は更新が必要です。.50／100万、10万超で入力Haiku 4.5は2026-10-19確認の[公式モデル資料](https://platform.claude.com/docs/en/models/haiku-4-5/overview)でActive (legacy)、通常入力$1/100万・出力$5/100万、200K context / 64K output。拡張思考を要求しない設定で試します。最新モデルの推奨という意味ではなく、このアダプターの通常Messages用の具体例です。契約・アカウントの利用可否は実API未検証です。[公式料金](https://platform.claude.com/docs/en/about-claude/pricing)の変更時は更新が必要です。.50・出力$2.50／100万。上の設定は全リクエストで高い方の単価を適用する保守的な会計であり、短いプロンプトでは請求見込みを最大5倍に計上します。キャッシュ作成は入力単価の2倍で計算し、割引は適用しません。閾値判定に使う入力はキャッシュ分も含むため、低い単価だけの設定を拒否します。契約・アカウントの利用可否は実API未検証です。

試験上限は未承認のため具体額を適用していません。起動前に利用者がモデルと上限を選べます。値は正の整数、$0.50なら500000。全入口で共有するクライアントが送信前に同時実行分を予約し、失敗分も見積もりで消費します。既存のタスク・日次の予算も併用します。プロセス再起動でリセットされ、複数サーバー間の上限共有や請求額の絶対保証にはなりません。少額すぎる場合は最初の呼び出し前に停止します。

ルート`.env`を読む既存のWSL用`pnpm --filter @open-team/app dev`、またはルートから`node --env-file=.env apps/app/src/server.ts`で設定を読みます。アプリを実行するには既存のDB・gateway等のローカル構成とアクセス／署名用設定も必要です。APIキーだけで未設定の作業コピーが起動するという意味ではありません。既存認証の移植や新規作成は別途承認が必要です。

`LLM_MODELS_JSON` はモデルIDから次の情報へのマップです。選択した全モデルの登録が必要です。

| フィールド | 意味 |
|---|---|
| `inputPerMTokMicroUsd` | 100万入力トークンあたりのマイクロ米ドル。正の整数 |
| `outputPerMTokMicroUsd` | 100万出力トークンあたりのマイクロ米ドル。正の整数。思考にも同じ単価を使う |
| `tools` | 通常の関数呼び出しに対応するか |
| `structuredOutput` | `tool`：出力専用の関数を強制し、引数をJSONテキストへ変換。`json_schema`：APIのネイティブJSON Schema出力。`none`：非対応 |
| `temperature` | temperature指定に対応するか。要求されるのにfalseなら通信前に拒否 |
| `anthropicMode` | 任意。`haiku55-no-thinking` はClaude APIのHaiku 5.5専用。アプリのtemperatureヒントを明示的に省略し、thinking disabled、effort low（lowヒント時）またはmediumで送信。high要求は拒否 |
| `reasoningEffort` | OpenAI互換（DeepSeek・OpenRouter など）で `reasoning_effort` のlow/high指定に対応するか。既定false |
| `maxOutputTokens` | 対応する出力トークン上限 |
| `contextWindow` | コンテキスト上限。要求本文のUTF-8バイト数＋4096の余裕＋出力上限で保守的にチェック |
| `tokenLimitParameter` | OpenAI互換の上限パラメーター。既定 `max_tokens`。`max_completion_tokens` を使うモデル（OpenAI の推論モデルなど）だけ明示 |

料金はプロバイダー・モデル・利用するコンテキスト長における**上限単価**を設定します。段階料金がある場合は利用範囲の最大単価、思考の別料金がある場合は出力単価に最大値を設定してください。自動で最新料金を取得するものではありません。設定誤りによる過少見積もりを防ぐため、運用者が料金改定時に更新してください。ゼロ・負数・不足設定は拒否します。無料のローカルモデルでも正の保守的な予算単価を設定します。

構造化出力の `tool` は既存の複雑な編成スキーマを保持できる設定です。専用の関数は業務ツールとして実行しません。引数をJSON文字列へ変換し、既存の呼び出し元が元のZodスキーマで検証します。これはAPIによる厳密なスキーマ保証を意味しません。`json_schema` もAPIごとの制限があり、未対応スキーマはAPIエラーになります。制約を黙って削除せず、検証失敗時は処理を止めます。

ツールの権限は能力設定から増えません。通常のツールとMCPツールは共通の形式へ戻し、すべて既存Kernelで判定します。複数のツール呼び出しID・結果を保持し、不明なツールは名前を推測して許可しません。

## 費用と失敗

試験用の総額制限には `LLM_SESSION_BUDGET_MICRO_USD` を設定します。再起動をまたいで制限する場合は `LLM_TRIAL_LEDGER_PATH` も設定し、利用者が決めた上限に対応する初期台帳を事前に用意してください。台帳の形式は `{"version":1,"limitMicroUsd":1000000,"chargedMicroUsd":0}` です（この例は上限$1）。既存の台帳は初期化せず引き継ぎます。指定した台帳がない場合は送信せず停止します。

- `LLM_TRIAL_LEDGER_PATH`を併用すると、同じ絶対パスを使う全プロセス・再起動後で試験上限を共有します。送信前に見積もりを原子的ロック下で台帳へ予約し、成功後は使用量で精算。失敗・クラッシュは見積もりを残します。台帳の破損・ロック競合は送信せず停止。上限値の変更は拒否します。台帳を削除・置換したり別パスを指定すると共有できないため、その操作は禁止して運用してください。既存のDB費用記録も保持します。

- 新HTTPアダプターは内部で再試行せず、edgeが429・5xx・通信失敗を再試行します。事前予算チェックには許可された全試行分の見積もりを含めます。実費は実際の使用量と、使用量不明の試行分の見積もりで記録します。
- Haiku 5.5を使う通常の依頼では出力上限を8192にし、edgeの自動再試行を無効にします。長いHTML等の途中切れを抑えつつ、再試行予約によって少額のタスク予算を圧迫することを避けます。失敗時は利用者が結果と予算を確認して再実行します。
- 単価・入力サイズによっては既存の少額タスク予算で開始できません。予算を自動で増額せず、上限の理由を示して停止します。必要なら利用者が通常の予算設定から見直してください。
- 使用量の欠落・不正、応答JSONの破損は成功扱いしません。使用量不明として保守的に見積もりを計上し、無料扱いしません。
- OpenAI互換のcompletion内のreasoning tokensは分離し、二重計上しません。Claudeの出力内のthinkingも重複計上しません。キャッシュは明示的に要求せず、返されたキャッシュ入力は割引を適用しません（作成分は入力単価の2倍で保守的に計算）。
- 拒否・トークン上限・未知の終了理由ではツールを実行しません。途中の構造化結果も利用しません。
- Kill Switch/AbortSignal、120秒タイムアウト、エラー本文の非表示は共通です。

## 機能の範囲

- Haiku 5.5は[移行ガイド](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)に基づきtemperature/top_p/top_kを送信せず、assistant prefillは通信前に拒否します。[思考仕様](https://platform.claude.com/docs/en/build-with-claude/thinking)で許可されたdisabledとlow/medium effortを明示します。既定adaptiveの署名付き履歴にはまだ対応しません。予期せぬthinking応答は止めます。disabledでJSON出力と業務ツールを混在させると必要なツール呼び出しが省略され得るため、この実装は両者を混在させません。
- Haiku 5.5の通常ツールと結果IDを保持し、構造化出力は専用ツール強制またはClaude APIのoutput_config.formatを使います。専用ツールの結果は業務実行しません。Bedrock用実装ではありません。refusalとmodel_context_window_exceededで業務ツールは実行せず、後者は打ち切りとして正規化します。新トークナイザーのため4.5の実測値を流用せず、送信本文バイト数による保守的な見積もりと応答usageを使います。

- Google検索GroundingはGemini専用です。他プロバイダーでは要求時に理由付きで停止します。今回の固定素材による告知制作は検索を使いません。
- 非Geminiで `thinkingLevel: low` は速度のヒントとして扱い、reasoningEffort非対応ならAPI既定にします。`high` を要求して非対応なら停止します。Claudeの拡張思考は有効化せず、思考ブロックを返すモデルも継続署名を失わないよう理由付きで停止します。通常のMessages応答を返す設定・モデルを使ってください。
- 画像入力、音声、サーバーツール、各社固有の特殊な思考モードやResponses専用モデルはこのテキスト・関数呼び出しアダプターの対象外です。必要能力のないモデルを自動的に別モデルへ切り替えません。
- 設定変更はサーバー再起動時に反映します。異なるプロバイダーへの切り替えは既存の実行中タスクが終わってから行ってください。モデル間で品質が同一になる保証はありません。
- 担当編成・通常実行は同じ選択済みクライアントを使います。

## 検証と参照

実キーなしのモックで、各HTTP契約、ツールと結果、構造化出力、拒否・打ち切り、使用量、秘密値、再試行を検証します。ローカルDBで各アダプターが既存の予算判定・承認待ちに接続されることも検証します。実APIでのモデルごとの動作・品質・料金照合は別途必要です。

2026-10-19に確認した公式資料：

- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Claudeのツール定義](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Claudeの構造化出力](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [OpenAIの構造化出力](https://developers.openai.com/api/docs/guides/structured-outputs)
