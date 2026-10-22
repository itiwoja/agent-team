-- 0021：費用の行の provider（API の提供元）を Gemini API（google）・Claude（anthropic）・DeepSeek・OpenRouter にそろえる。
-- 以前の openai は過去の行を壊さないために CHECK に残す（新しい行は書かない）。

ALTER TABLE usage_records DROP CONSTRAINT usage_records_provider_check;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_provider_check
  CHECK (provider IN ('google', 'anthropic', 'deepseek', 'openrouter', 'openai'));
