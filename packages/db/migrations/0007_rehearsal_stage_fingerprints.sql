-- 0007：依頼（順番）の走行の開始時の指紋（担当ごと）。合格証を出すとき、走行のあとで広げた・ツールが変わった担当を見つける（BR-81）
-- 仕事の走行は policy_hash・tool_hashes の列で足りる。依頼は担当が複数なので、[{ jobId, policyHash, toolHashes }] を担当の数だけ持つ。
-- 既存の行は NULL（指紋のない走行）。指紋のない依頼の走行からは合格証を出さない（certify.ts）。

ALTER TABLE rehearsal_runs
  ADD COLUMN stage_fingerprints jsonb NULL
    CHECK (stage_fingerprints IS NULL OR jsonb_typeof(stage_fingerprints) = 'array');
