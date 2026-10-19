// Should の世界（朝のまとめ・依存関係の更新係）は manifest と supportedFaults だけの枠（15:275・288-305、D-53）
// 仕入れ係の一周が URL で動いてから中身を作る。作るときは入力スキーマのキーと argRoles を揃える（BR-56）

import { deepFreeze } from "../util.ts";
import type { SimConnectorManifest, WorldFrame } from "../world.ts";

/** 朝のまとめ（15:290-296）。web_fetch は組み込みのツールなので manifest に入れない */
export const BRIEF_CONNECTORS: readonly SimConnectorManifest[] = deepFreeze<SimConnectorManifest[]>([
  {
    world: "brief",
    slug: "news",
    displayName: "ニュース",
    path: "/mcp/brief/news",
    tools: [{ name: "list_articles", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "ニュースの確認", units: {} }],
  },
  {
    world: "brief",
    slug: "calendar",
    displayName: "予定表",
    path: "/mcp/brief/calendar",
    tools: [{ name: "list_events", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "予定の確認", units: {} }],
  },
  {
    world: "brief",
    slug: "weather",
    displayName: "天気",
    path: "/mcp/brief/weather",
    tools: [{ name: "get_forecast", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "天気の確認", units: {} }],
  },
  {
    world: "brief",
    slug: "mail",
    displayName: "メール",
    path: "/mcp/brief/mail",
    tools: [
      {
        name: "send",
        classification: "write",
        argRoles: { to: "destination", body: "content" },
        scope: null,
        verify: "none",
        actionNoun: "メール",
        units: {},
      },
    ],
  },
]);

/** 依存関係の更新係（15:300-305）。本物の GitHub にはつながない */
export const REPO_CONNECTORS: readonly SimConnectorManifest[] = deepFreeze<SimConnectorManifest[]>([
  {
    world: "repo",
    slug: "repo",
    displayName: "リポジトリ",
    path: "/mcp/repo/repo",
    tools: [
      { name: "read_file", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "ファイルの確認", units: {} },
      { name: "list_issues", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "イシューの確認", units: {} },
      {
        name: "push_commit",
        classification: "write",
        // branch：destination（main は不可。O-07）
        argRoles: { branch: "destination", files: "content" },
        scope: null,
        verify: "none",
        actionNoun: "コミット",
        units: {},
      },
      {
        name: "create_pull_request",
        classification: "write",
        argRoles: { base: "destination", "packages[].name": "option", body: "content" },
        scope: null,
        verify: "none",
        actionNoun: "PR の作成",
        units: {},
      },
    ],
  },
  {
    world: "repo",
    slug: "ci",
    displayName: "CI",
    path: "/mcp/repo/ci",
    tools: [{ name: "get_status", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "CI の確認", units: {} }],
  },
]);

export const BRIEF_FRAME: WorldFrame = Object.freeze({
  id: "brief",
  connectors: BRIEF_CONNECTORS,
  supportedFaults: Object.freeze(["F-09", "F-10"] as const),
  implemented: false,
});

export const REPO_FRAME: WorldFrame = Object.freeze({
  id: "repo",
  connectors: REPO_CONNECTORS,
  supportedFaults: Object.freeze(["F-08", "F-11", "F-12", "F-13"] as const),
  implemented: false,
});
