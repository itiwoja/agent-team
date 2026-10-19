// ID の形（ワークスペース・リハーサル・走行・タスク・Intent・スナップショット）。
// Postgres の uuid 型と同じく 8-4-4-4-12 の16進を受け、小文字にそろえる（ヘッダーと本文で大文字小文字が違っても同じ行を引く）

import { z } from "zod";

export const IdSchema = z.guid().transform((s) => s.toLowerCase());

/** UUID の形なら小文字にして返す。違えば null */
export function parseId(raw: string): string | null {
  const r = IdSchema.safeParse(raw);
  return r.success ? r.data : null;
}
