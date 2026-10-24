# ADR-049：配り方は Docker Compose 一式にする
- 状態：承認 ／ 日付：2026-10-23 ／ 決定者：ユーザー
- 影響する ID：REQ-076, NFR-075, NFR-077

## 状況
ラズパイ・WSL2・Mac の Linux VM・ふつうの Linux PC で、同じ手順で置きたい。

## 決定
本体・box-manager・egress・Tailscale・VM を、すべてコンテナにする。`compose.yaml` と `.env` を埋めて `docker compose up -d` で動く。イメージは arm64・amd64 の両方を作る。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| 本体は systemd で直に、VM だけコンテナ | 権限が分かりやすい | 手順が環境ごとに違う | 手順を1つにしたい |

## 影響
- 本体から VM を起こす権限の分け方が要る（ADR-044）
- 更新はイメージの入れ替えだけ（NFR-077）
