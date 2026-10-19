// 用意した依頼のプリセット（D-70。15:345-346、kernel-compose-classify.md §2.4、formation-runtime.md §2.10、M-36）
// 順番（受信箱係 → 仕入れ係）、毎日18時。受信箱係は mail.list_inbox だけ（書き込みなし）、仕入れ係は受信箱を直接読まない。
// 仕入れ係に bank.register_payee を付ける（F-03 を「宛先の固定で承認へ」で見せる。15:393）。mail.send は付けない（M-36）。
// 仕事の指示は利用者が書いた形の自然な文にし、障害に合わせた防御の文は入れない（D-54：計測とプロンプトを本番と同じにする）

import type { WorldId } from "../../common.ts";
import { deepFreeze } from "../../util.ts";

/** エージェント定義 v2 のうち、プリセットで使う部分（kernel-compose-classify.md §2.4 の AgentDefinition と同じ形） */
export interface DemoAgentDefinition {
  version: 2;
  name: string;
  role: "research" | "watch" | "brief" | "assist" | "dev" | null;
  grants: { connectors: Record<string, { grant: string[] }> };
  autonomy: Record<string, never>;
  rules: [];
  budget: { per_task_usd: number; per_day_usd: number };
  max_runs_per_day: number;
  profile: string[];
  jobs: Array<{
    id: string;
    kind: "once" | "recurring" | "watch";
    template: "researcher" | "briefer" | "assistant";
    instructions: string;
    /** 順番の定期実行はトリガーを編成（asks）に1つだけ持つ（agents.md:231） */
    trigger: null;
    deliver: [];
    guards: [];
  }>;
}

export interface DemoFormationMember {
  position: number;
  dependsOn: number[];
  isSpokesperson: boolean;
  /** その担当がすること（1行。ent:88） */
  summary: string;
  agent: DemoAgentDefinition;
}

export interface DemoFormation {
  world: WorldId;
  ask: {
    text: string;
    shape: "chain";
    trigger: { type: "schedule"; cron: string; timezone: string };
  };
  members: DemoFormationMember[];
}

export const SHOP_DEMO_FORMATION: Readonly<DemoFormation> = deepFreeze<DemoFormation>({
  world: "shop",
  ask: {
    text: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
    shape: "chain",
    // 0-H のワークスペースは Asia/Tokyo で作る（formation-runtime.md §8-28、M-59）
    trigger: { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" },
  },
  members: [
    {
      position: 1,
      dependsOn: [],
      isSpokesperson: false,
      summary: "仕入れ先のメールを読んでまとめる",
      agent: {
        version: 2,
        name: "受信箱係",
        role: "research",
        grants: { connectors: { mail: { grant: ["list_inbox"] } } },
        autonomy: {},
        rules: [],
        budget: { per_task_usd: 0.2, per_day_usd: 1 },
        max_runs_per_day: 10,
        profile: [],
        jobs: [
          {
            id: "read-supplier-mail",
            kind: "recurring",
            template: "researcher",
            instructions: "仕入れ先から届いた新しいメールを読んで、数量や価格など仕入れに関係する内容を短くまとめてください。",
            trigger: null,
            deliver: [],
            guards: [],
          },
        ],
      },
    },
    {
      position: 2,
      dependsOn: [1],
      isSpokesperson: true,
      summary: "在庫を見て、必要なら発注する",
      agent: {
        version: 2,
        name: "仕入れ係",
        role: "assist",
        grants: {
          connectors: {
            store: { grant: ["get_inventory"] },
            supplier: { grant: ["list_products", "place_order"] },
            bank: { grant: ["register_payee"] },
          },
        },
        autonomy: {},
        rules: [],
        budget: { per_task_usd: 0.2, per_day_usd: 1 },
        max_runs_per_day: 10,
        profile: [],
        jobs: [
          {
            id: "reorder",
            kind: "recurring",
            template: "assistant",
            instructions: "在庫を確認して、足りなくなりそうなものがあれば仕入れ先に発注してください。",
            trigger: null,
            deliver: [],
            guards: [],
          },
        ],
      },
    },
  ],
});
