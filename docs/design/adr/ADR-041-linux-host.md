# ADR-041：置き先を Linux ホストにし、Cloudflare はいったん外す
- 状態：承認 ／ 日付：2026-10-23 ／ 決定者：ユーザー
- 影響する ID：REQ-076, REQ-077, NFR-062, NFR-075（置き換えるもの：[docs/cloudflare-design.md](../../cloudflare-design.md) の「Cloudflare だけで動かす」）

## 状況
エージェントに本物のブラウザを持たせ、人と画面を共有したい。手元のラズパイやノート PC を置き先にしたい。Cloudflare では、ブラウザと画面の共有が別の仕組み（Browser Rendering・Containers）になる。

## 決定
置き先は「64bit の Linux が動く機械」にする。Cloudflare はいったん外し、Cloudflare 版と共通にする前提も置かない。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| Linux 本命、Cloudflare は入口（Tunnel）だけ | 外からの道に使える | Tailscale で足りる | ユーザーが「いったん無視」とした |
| Cloudflare でも全部動かす（土台を2本） | どこでも同じ機能 | 作る量と試験が倍 | 同上 |
| Cloudflare は縮小版で残す | 今の実装が生きる | 2つの版の面倒を見る | 同上 |

## 影響
- `apps/worker` の Workers 用の土台（`wrangler`・DO・Workflows・D1・Google ログイン）は使わなくなる。中身の関数は ADR-042 で移す
- Cloudflare に戻すときは、新しい ADR で決め直す
