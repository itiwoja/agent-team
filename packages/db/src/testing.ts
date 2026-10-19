// 試験用のデータベース（@open-team/db/testing）。DB を使う試験はどのパッケージもこれを使い、試験ごとに新しいデータベースにする。
// - TEST_DATABASE_URL があれば、そのサーバー（データベースを作れる利用者）を使う（CI のサービスのコンテナなど）
// - なければ docker で postgres:16（compose.yaml と同じ digest）のコンテナ ot-db-test を1つ起動して使い回す
// - マイグレーションを流した型紙から CREATE DATABASE … TEMPLATE で写す（README §6）
export * from "./test-database.ts";
export * from "./test-helpers.ts";
export * from "./testing-fixtures.ts";
