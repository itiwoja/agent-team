// 画面・判定の文が名前や操作名を引くコネクタの定義（Google カレンダー・GitHub）

import { GCAL_CONNECTOR, type GcalConnectorManifest } from "@open-team/gcal-core";
import { GITHUB_CONNECTOR, type GithubConnectorManifest } from "@open-team/github-core";

export const KNOWN_CONNECTORS: readonly (GcalConnectorManifest | GithubConnectorManifest)[] = [GCAL_CONNECTOR, GITHUB_CONNECTOR];
