// 画面・判定の文が名前や操作名を引くコネクタの定義（sim-core の仕入れ係の世界のコネクタと、模擬の Google カレンダー）。
// 模擬のカレンダーは gcal-core の GCAL_CONNECTOR と同じツール・操作名（world・path を持つ SIM_GCAL_CONNECTOR で入れる。findToolManifest の型に合わせるため）

import { SHOP_CONNECTORS, SIM_GCAL_CONNECTOR, type SimConnectorManifest } from "@open-team/sim-core";

export const KNOWN_CONNECTORS: readonly SimConnectorManifest[] = [...SHOP_CONNECTORS, SIM_GCAL_CONNECTOR];
