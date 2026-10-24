# 10. 図：状態遷移図
- プロジェクト：Agent-Team-Open ／ 版数：v1.1（2026-10-24） ／ 親：[10 図](README.md)

> **3行で**
> 1. v1.0 で足したのは `wakes.status`・`turns.status`・画面の番・`scheduled_wakes.status`・`routine_proposals.status` の 5 つ。
> 2. v0.6 の `boxes.status`・`boxes.control`・`takeovers.status`・`browser_checks.status`・`sandbox_commands.status` は、VM が眠って起きる形に直した。
> 3. 値の意味は [04 ステータス定義](../04_functional_spec/README.md#ステータス定義)。

---

### wakes.status
```mermaid
stateDiagram-v2
 [*] --> queued : 受付
 [*] --> dropped : source_key が重複（入れない）
 queued --> attached : 動いているターンに結びつけた
 attached --> consumed : 次の歩みで渡した
 attached --> queued : 渡す前にターンが閉じかけた（閉じずに続けるか、次のターンへ）
 queued --> consumed : ターン・タスクに渡した
 consumed --> queued : 失敗したターンから戻す（2 回まで）
 queued --> dropped : 日次の上限（ルーチン・予約・webhook だけ）・行き先がない
 consumed --> [*]
 dropped --> [*]
```

### turns.status
```mermaid
stateDiagram-v2
 [*] --> running : きっかけ
 running --> running : 歩む（持ち主のチャットは次の歩みの頭へ）
 running --> done : 道具を呼ばずに終わった・記憶を更新した
 running --> halted : $1・40 歩・10 分・日次
 running --> failed : LLM の失敗（3 回）
 done --> [*] : 眠る
 halted --> [*]
 failed --> [*]
```

### 画面の番（boxes.screen_task_id）
```mermaid
stateDiagram-v2
 [*] --> 空き
 空き --> 使用中 : タスクが画面の道具を使う（条件つきの UPDATE）
 使用中 --> 空き : タスクの終わり・取り消し・通常の実行中に 3 分使わない（screen_epoch +1）
 使用中 --> 空き : VM が止まった・控えに戻す
 使用中 --> 使用中 : 交代（control が human の間も番はそのまま）
```

### scheduled_wakes.status
```mermaid
stateDiagram-v2
 [*] --> pending : schedule_wake
 pending --> fired : 時刻になった（wakes に scheduled）
 pending --> cancelled : 持ち主が消した
 fired --> [*]
 cancelled --> [*]
```

### routine_proposals.status
```mermaid
stateDiagram-v2
 [*] --> pending : propose_routine
 pending --> approved : ○（API-142）→ routines に行
 pending --> rejected : ×
 pending --> expired : 7 日
 approved --> [*]
 rejected --> [*]
 expired --> [*]
```

### boxes.status
```mermaid
stateDiagram-v2
 [*] --> starting
 starting --> running : box-agent が応答
 starting --> failed : 60秒応答なし
 running --> stopping : 10分使わない・持ち主・控えに戻す・作り直す
 stopping --> stopped
 running --> failed : 落ちた
 stopped --> [*] : 眠った（次に使うときは新しい世代）
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
 active --> expired : 15分操作なし・再起動（タスクは返事待ち、VM は止めない）
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

