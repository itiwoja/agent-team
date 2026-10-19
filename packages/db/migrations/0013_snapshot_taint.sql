-- 作業場の控えに汚染の印を付ける（SG-05：汚染を持ち越す。17_security_governance.md）
-- 汚染されたタスクが書いたファイルが、次のタスクで「きれいな」状態として洗い流されないようにする。
-- 1. agent_workspace_snapshots に tainted・taint_sources（tasks と同じ形）を足す。控えを残すときに、そのタスクの汚染を写す
--    （edge の sandboxArchive。run_command は実行役が取った時点でタスクが sandbox_run で汚染されている：sandboxNext）。
--    次のタスクが控えを受け取ったら（sandboxClaim）、受け取ったタスクを workspace_snapshot を出どころとして汚染する
-- 2. パックが置いた控え（source = 'pack'）と、オーナーが最初に戻した控え（source = 'reset'）は汚染なし
-- 3. 控えは書き換えない（UPDATE を拒む）：汚染の印を消す・汚染なしの控えの中身を差し替える、の1列の書き換えを塞ぐ。消す（古い控えの整理）はできる

ALTER TABLE agent_workspace_snapshots
  ADD COLUMN tainted       boolean NOT NULL DEFAULT false,
  ADD COLUMN taint_sources jsonb   NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(taint_sources) = 'array');

-- 既存の控え（source = 'task'）：控えの鎖をたどって汚染を決める（SG-07 の最終監査の直し）。
-- 控えは「担当の最新の控え → 次の作業場」の鎖なので、ある控えの中身に効きうるのは、その担当のタスクのうち、
-- その控えより前（created_at 以前）に作業場を開いた（sandbox_sessions がある）もの。
-- 1. その中に外の内容で汚染されたタスク（sandbox_run・workspace_snapshot だけの汚染と、upstream が sandbox_run だけの受け渡し・連絡は除く）が
--    あれば、その出どころ（受け渡し・連絡は upstream を平らにしたもの）を upstream にした workspace_snapshot で汚染する。
--    汚染されたタスクのあとの控えは、すべてこれに当たる（洗い流しを残さない：SG-05 の監査）
-- 2. なければ、その控えを残したタスクが run_command を実行し始めていれば（または汚染に sandbox_run があれば）sandbox_run
-- 3. どちらもなければ汚染なし（汚染なし・コマンドなしのタスクの控えに、元の分からない印を付けて担当を止めない）
-- パックの控えは汚染なし
WITH snaps AS (
  SELECT s.id, s.workspace_id, s.agent_id, s.task_id, s.created_at,
         to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM agent_workspace_snapshots s
   WHERE s.source = 'task'
), chain_sources AS (
  -- 鎖の中の外の内容の出どころ（平らにしたもの）
  SELECT sn.id AS snap_id, u.src
    FROM snaps sn
    JOIN tasks t ON t.workspace_id = sn.workspace_id AND t.agent_id = sn.agent_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.taint_sources) = 'array' THEN t.taint_sources ELSE '[]'::jsonb END) e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN e->>'kind' IN ('handoff', 'team_message') AND jsonb_typeof(e->'upstream') = 'array' AND jsonb_array_length(e->'upstream') > 0
           THEN e->'upstream' ELSE jsonb_build_array(e) END
    ) AS u(src)
   WHERE EXISTS (SELECT 1 FROM sandbox_sessions ss
                  WHERE ss.workspace_id = sn.workspace_id AND ss.agent_id = sn.agent_id AND ss.task_id = t.id AND ss.created_at <= sn.created_at)
     AND COALESCE(e->>'kind', '') NOT IN ('sandbox_run', 'workspace_snapshot')
     AND NOT (e->>'kind' IN ('handoff', 'team_message') AND jsonb_typeof(e->'upstream') = 'array' AND jsonb_array_length(e->'upstream') > 0
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e->'upstream') x WHERE x->>'kind' IS DISTINCT FROM 'sandbox_run'))
), chain AS (
  SELECT snap_id, jsonb_agg(DISTINCT src) AS upstream FROM chain_sources GROUP BY snap_id
), judged AS (
  SELECT sn.id, sn.task_id, sn.at, c.upstream,
         EXISTS (SELECT 1 FROM sandbox_commands cmd
                  WHERE cmd.workspace_id = sn.workspace_id AND cmd.task_id = sn.task_id AND cmd.tool = 'run_command' AND cmd.started_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM tasks t2 CROSS JOIN LATERAL jsonb_array_elements(
                      CASE WHEN jsonb_typeof(t2.taint_sources) = 'array' THEN t2.taint_sources ELSE '[]'::jsonb END) e2
                     WHERE t2.workspace_id = sn.workspace_id AND t2.id = sn.task_id AND e2->>'kind' = 'sandbox_run') AS ran
    FROM snaps sn
    LEFT JOIN chain c ON c.snap_id = sn.id
)
UPDATE agent_workspace_snapshots s
   SET tainted = (x.upstream IS NOT NULL OR x.ran),
       taint_sources =
         CASE WHEN x.upstream IS NOT NULL
              THEN jsonb_build_array(jsonb_build_object('kind', 'workspace_snapshot', 'snapshotId', x.id, 'fromTaskId', x.task_id,
                                                        'upstream', x.upstream, 'at', x.at))
                   || CASE WHEN x.ran THEN jsonb_build_array(jsonb_build_object('kind', 'sandbox_run', 'at', x.at)) ELSE '[]'::jsonb END
              WHEN x.ran THEN jsonb_build_array(jsonb_build_object('kind', 'sandbox_run', 'at', x.at))
              ELSE '[]'::jsonb END
  FROM judged x
 WHERE x.id = s.id
   AND (x.upstream IS NOT NULL OR x.ran);

-- オーナーが担当の作業場を最初に戻した控え（source = 'reset'。POST /agents/{agentId}/workspace/reset：SG-07 の最終監査の直し）。
-- パックから入った担当はパックのファイル、そうでなければ空。汚染なし（task_id は持たない）
ALTER TABLE agent_workspace_snapshots DROP CONSTRAINT agent_workspace_snapshots_source_check;
ALTER TABLE agent_workspace_snapshots ADD CONSTRAINT agent_workspace_snapshots_source_check CHECK (source IN ('task', 'pack', 'reset'));

ALTER TABLE agent_workspace_snapshots
  ADD CONSTRAINT agent_workspace_snapshots_taint_chk CHECK (tainted OR taint_sources = '[]'::jsonb),
  ADD CONSTRAINT agent_workspace_snapshots_pack_clean_chk CHECK (source = 'task' OR NOT tainted);

CREATE FUNCTION agent_workspace_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_workspace_snapshots cannot be updated';
END;
$$;
CREATE TRIGGER agent_workspace_snapshots_immutable BEFORE UPDATE ON agent_workspace_snapshots
  FOR EACH ROW EXECUTE FUNCTION agent_workspace_snapshots_immutable();
