-- 0023：OpenAI 互換の提供元を増やし、任意の接続先（custom）も使えるようにしたので、費用の行の provider をそれに合わせて広げる。
-- 名前は llm の LLM_PROVIDER と同じ（Gemini API だけ google）。openai は 0021 で過去の行用に残していたが、再び新しい行でも使う。

ALTER TABLE usage_records DROP CONSTRAINT usage_records_provider_check;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_provider_check
  CHECK (provider IN ('google', 'anthropic', 'openai', 'deepseek', 'openrouter', 'xai', 'groq', 'mistral', 'together',
                      'fireworks', 'cerebras', 'moonshot', 'zai', 'qwen', 'custom'));
