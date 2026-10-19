// パックの形（D-116）。中身は library/ に1パック1ファイルで置き、catalog.ts で棚に並べる

/** 棚の分類（並びはこの順で札に出す） */
export const PACK_CATEGORIES = ["学び・教育", "つくる", "売る・お店", "お金・事務"] as const;
export type PackCategory = (typeof PACK_CATEGORIES)[number];

export type PackTemplate = "researcher" | "briefer" | "watcher" | "assistant" | "dev-coder" | "reviewer";

export interface PackSkill {
  name: string;
  description: string;
  body: string;
}

export interface PackFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface PackAgent {
  key: string;
  name: string;
  role: "research" | "assist" | "brief" | "watch" | "dev";
  template: PackTemplate;
  /** この担当がすること（1行。棚とライブラリに出す） */
  summary: string;
  /** 仕事の指示（依頼のたびの指示の土台。プランナーが使い回すときの手がかりにもなる） */
  instructions: string;
  /** この担当が読めるスキル（skills の name） */
  skills: string[];
  /** 作業場に最初から置くファイル（dev-coder・reviewer のスクリプト） */
  files?: PackFile[];
}

export interface PackDefinition {
  id: string;
  version: number;
  name: string;
  /** 1行の売り文句 */
  tagline: string;
  description: string;
  /** 誰のためか（棚の札） */
  audience: string;
  /** 棚の分類（絞り込みの札） */
  category: PackCategory;
  agents: PackAgent[];
  skills: PackSkill[];
  /** 「試してみる」の依頼の例（押すと入口に入る） */
  examples: string[];
}
