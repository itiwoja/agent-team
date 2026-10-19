// パック（D-116）：GET /packs（棚）・POST /packs/{packId}/install（入れる）。入れられるのは owner・maintainer（依頼を頼める役割と同じ）
import type { AppDeps } from "../deps.ts";
import { requireRole, sessionOf } from "../http.ts";
import { installPack, listPacks } from "../packs/install.ts";
import type { ApiRouter } from "./router.ts";

const INSTALLERS = ["owner", "maintainer"] as const;

export function packRoutes(r: ApiRouter, deps: AppDeps): void {
  r.get("/packs", async (c) => c.json(await listPacks(deps, sessionOf(c))));

  r.post("/packs/:packId/install", async (c) => {
    const s = sessionOf(c);
    requireRole(s, INSTALLERS);
    const packId = c.req.param("packId") ?? "";
    return c.json(await installPack(deps, s, packId), 201);
  });
}
