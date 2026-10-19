// パック（D-116）の API の形（GET /packs・POST /packs/{packId}/install）。画面（apps/web）はこの形に合わせる
import { z } from "zod";

const Iso = z.string();

export const PackViewSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  audience: z.string(),
  /** 棚の分類（絞り込みの札） */
  category: z.string(),
  agents: z.array(
    z.object({
      /** 入れたときに作った担当の id（pack_installs.agent_ids の同じ位置）。入れていない・対応が取れない（古い版など）ときは null */
      agentId: z.string().nullable(),
      name: z.string(),
      summary: z.string(),
      template: z.string(),
      /** この担当が読めるスキルの名前 */
      skills: z.array(z.string()),
      /** 作業場に最初から置くファイル（スクリプト） */
      files: z.array(z.string()),
    }),
  ),
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
  examples: z.array(z.string()),
  /** 作業場が要る担当（書いて動かす）がいるか */
  needsSandbox: z.boolean(),
  /** このワークスペースで作業場を使えるか（使えなければ、書いて動かす担当は作業場の道具なしで動く） */
  sandboxAvailable: z.boolean(),
  installedAt: Iso.nullable(),
});
export type PackView = z.infer<typeof PackViewSchema>;

export const ListPacksResponseSchema = z.object({
  /** 分類の並び（札の順） */
  categories: z.array(z.string()),
  packs: z.array(PackViewSchema),
});
export type ListPacksResponse = z.infer<typeof ListPacksResponseSchema>;

export const InstallPackResponseSchema = z.object({
  pack: PackViewSchema,
  agents: z.array(z.object({ agentId: z.string(), name: z.string() })),
});
export type InstallPackResponse = z.infer<typeof InstallPackResponseSchema>;
