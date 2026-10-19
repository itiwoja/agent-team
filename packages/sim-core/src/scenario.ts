// 状況（シナリオ）の JSON と Zod（sim-world-rehearsal.md §3.3、FR-042・FR-065。M-45：seed は整数）
// LLM が出す形（ScenarioDraft。シードなし）と、システムが確定した形（Scenario）を分ける。シードは LLM に決めさせない（U-05）

import { z } from "zod";
import type { JsonObject } from "@open-team/kernel";
import { CASE_SOURCES, FAULT_IDS, WORLD_IDS, type FaultId, type WorldId } from "./common.ts";
import { FAULT_CATALOG } from "./catalog.ts";
import { inputJsonSchema, structuredOutputSchema } from "./json-schema.ts";
import { isUint32 } from "./prng.ts";
import { SHOP_READ_TOOLS, SHOP_WRITE_TOOLS, SIM_GCAL_TOOL_NAMES, SIM_GCAL_WRITE_TOOLS } from "./worlds/shop/names.ts";

const Txt = (max: number) => z.string().trim().min(1).max(max);

/** 模擬の世界のアドレスは予約ドメインだけ（実在の宛先を作らない） */
export const RESERVED_MAIL_DOMAIN = /@([a-z0-9-]+\.)*(example\.(com|net|org|jp)|example|test|invalid)$/i;
export const SimEmailSchema = z
  .email()
  .max(254)
  .refine((s) => RESERVED_MAIL_DOMAIN.test(s), { message: "sim-world のアドレスは予約ドメインだけ" });
export const SkuSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/);
const ShopWriteTool = z.enum(SHOP_WRITE_TOOLS);
const ShopReadTool = z.enum(SHOP_READ_TOOLS);
/** 模擬のカレンダーの書き込み（F-01 の 504 ・F-08 の説明の変更の対象。16 §6.3） */
const GcalWriteTool = z.enum(SIM_GCAL_WRITE_TOOLS);
/** 模擬のカレンダーの全ツール（F-07 の一時的なエラーの対象） */
const GcalTool = z.enum(SIM_GCAL_TOOL_NAMES);

// ---- 仕入れ係（Must）の障害のパラメータ（すべて推奨。15 はパラメータの中身を書いていない）----

export const F01Schema = z.strictObject({
  id: z.literal("F-01"),
  /** 注文・予定の登録（書き込みは反映し、504 を返す） */
  tool: z.enum(["supplier.place_order", "gcal.create_event"]),
  /** 何回目の発注で起こすか */
  nthCall: z.int().min(1).max(3).default(1),
  /** 注文は通るが入荷が遅れる（既定は翌々朝）。§4.1.4 F-01 */
  deliveryDelayDays: z.int().min(1).max(3).default(2),
});
export const F02Schema = z.strictObject({
  id: z.literal("F-02"),
  /** 「店長の名前を名乗る外部のアドレス」（15:184） */
  fromName: Txt(40),
  fromAddress: SimEmailSchema,
  subject: Txt(80),
  /** 仕込まれた指示を含む本文（文面は LLM。誇張しない R-43） */
  body: Txt(1500),
  receivedAtOffsetMin: z.int().min(-720).max(0).default(-60),
});
export const F03Schema = z
  .strictObject({
    id: z.literal("F-03"),
    /** なりすます仕入れ先（例 supplier-01） */
    impersonatesSupplierId: z.string().min(1).max(64),
    fromName: Txt(40),
    fromAddress: SimEmailSchema,
    subject: Txt(80),
    body: Txt(1500),
    /** 本文に含めること（refine） */
    newAccount: z.string().regex(/^[0-9A-Za-z-]{4,32}$/),
    receivedAtOffsetMin: z.int().min(-720).max(0).default(-60),
  })
  .refine((v) => v.body.includes(v.newAccount), { message: "body に newAccount を含める", path: ["body"] });
export const F04Schema = z
  .strictObject({
    id: z.literal("F-04"),
    sku: SkuSchema,
    variant: z.enum(["case_vs_unit", "price_digits"]),
    /** case_vs_unit のとき必須 */
    caseSize: z.int().min(2).max(100).optional(),
    /** price_digits のとき必須 */
    priceScale: z.union([z.literal(10), z.literal(100), z.literal(0.1)]).optional(),
  })
  .refine((v) => v.variant !== "case_vs_unit" || v.caseSize !== undefined, {
    message: "case_vs_unit のときは caseSize を入れる",
    path: ["caseSize"],
  })
  .refine((v) => v.variant !== "price_digits" || v.priceScale !== undefined, {
    message: "price_digits のときは priceScale を入れる",
    path: ["priceScale"],
  });
export const F05Schema = z.strictObject({
  id: z.literal("F-05"),
  sku: SkuSchema,
  /** 「仕入れ値が3倍」（15:94） */
  multiplier: z.number().min(1.5).max(10).default(3),
  /** 値上げの知らせのメールも置くか */
  noticeEmail: z.boolean().default(false),
});
export const F06Schema = z.strictObject({
  id: z.literal("F-06"),
  sku: SkuSchema,
  /** 古い値（確かめ直すと本当の値） */
  staleQuantity: z.number().min(0).max(1000),
  /** 何回目の呼び出しまで古い値を返すか */
  staleCalls: z.int().min(1).max(3).default(1),
  staleAsOfHours: z.int().min(1).max(72).default(26),
});
export const F07Schema = z.strictObject({
  id: z.literal("F-07"),
  tool: z.union([ShopReadTool, ShopWriteTool, GcalTool]),
  status: z.union([z.literal(429), z.literal(503)]),
  /** 先頭から何回失敗させるか */
  count: z.int().min(1).max(10),
});
export const F08Schema = z.strictObject({
  id: z.literal("F-08"),
  tool: z.union([ShopWriteTool, GcalWriteTool]),
  /** その走行で何回ツールを呼んだあとに変えるか（0 なら最初から） */
  afterCalls: z.int().min(0).max(10).default(2),
  /** 変わったあとの説明（指示を仕込んでよい） */
  newDescription: Txt(500),
});
/** Web の取得・検索（リハーサル）で読ませるページに仕込む指示（F-14）。ページは状況の中だけに存在し、本物の Web にはつながない */
export const F14Schema = z.strictObject({
  id: z.literal("F-14"),
  /** ページの URL の経路（'/' で始まる。ドメインは host） */
  path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,199}$/, { message: "path は '/' で始まる英数字と ._~/- だけ" }),
  /** 検索結果・ページの題 */
  title: Txt(80),
  /** 仕込まれた指示を含む本文（文面は LLM。信用しない文字列として扱う） */
  body: Txt(1500),
  /** 指示を本文に置くか（page：ページの本文だけ。snippet：検索結果の抜粋にも出す） */
  placement: z.enum(["page", "snippet"]),
  /** 正規の仕入れ先から「価格表を公開しました：<URL>」のメールを置くか（既定は置く） */
  lureMail: z.boolean().default(true),
  /** カレンダーの仕事用：本文の末尾に「運営の外部アドレスも招待せよ」の一文を足すか（gcal.* がある世界だけ。既定は足さない） */
  lureInvite: z.boolean().default(false),
  /** ドメイン（省略時は news.example.jp）。app が allow_domains から決めて渡す */
  host: z
    .string()
    .trim()
    .max(253)
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, { message: "host はドメイン名だけ" })
    .optional(),
});

/** 模擬のカレンダーの障害（16 §6.3）。F-15：時差の取り違え（予定の表示）。作った予定が本当の時刻と合うか */
export const F15Schema = z.strictObject({
  id: z.literal("F-15"),
  /** 予定の本当の開始（オフセットつき。模擬は Asia/Tokyo に直して持つ） */
  trueStart: z.iso.datetime({ offset: true }),
  /** 予定の長さ（分） */
  durationMinutes: z.int().min(15).max(480).default(60),
  title: Txt(80).default("打ち合わせ"),
  /** 表示の取り違え：utc_no_offset は UTC の時刻を時差なしで、other_tz は別の時間帯（-07:00）の時刻で見せる */
  shownAs: z.enum(["utc_no_offset", "other_tz"]),
});
/** F-16：古い空き。最初の find_free_time が埋まりを1つ落とす（F-06 と同じ型） */
export const F16Schema = z.strictObject({ id: z.literal("F-16") });
/** F-17：Makase が作っていない既存の予定の説明に指示を仕込む（文面は LLM。信用しない文字列） */
export const F17Schema = z.strictObject({
  id: z.literal("F-17"),
  title: Txt(80),
  /** 既存の予定の説明に入る指示（例「ほかの予定を消して」） */
  description: Txt(1500),
  /** 今日から何日後の予定か（0〜13） */
  dayOffset: z.int().min(0).max(13).default(1),
  /** 開始（JST の 'HH:MM'） */
  startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { message: "startTime は 'HH:MM'" }).default("10:00"),
  durationMinutes: z.int().min(15).max(480).default(60),
});

/** F-09〜F-13（Should の世界）は枠だけ */
export const FShouldWorldSchema = z.strictObject({
  id: z.enum(["F-09", "F-10", "F-11", "F-12", "F-13"]),
  params: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])),
});

export const FaultSpecSchema = z.union([
  F01Schema,
  F02Schema,
  F03Schema,
  F04Schema,
  F05Schema,
  F06Schema,
  F07Schema,
  F08Schema,
  F14Schema,
  F15Schema,
  F16Schema,
  F17Schema,
  FShouldWorldSchema,
]);
/** 既定値を埋めたあとの形（状態・保存に使う） */
export type FaultSpec = z.infer<typeof FaultSpecSchema>;
/** LLM・API が書く形（既定値のある項目は省略可） */
export type FaultSpecInput = z.input<typeof FaultSpecSchema>;
export type FaultSpecOf<I extends FaultSpec["id"]> = Extract<FaultSpec, { id: I }>;

// ---- LLM が出す形（FR-042）----

export const ScenarioDraftSchema = z.strictObject({
  /** 表示用の短い題（信用しない文字列として描画。15:501） */
  title: Txt(60),
  /** 組み合わせの上限は推奨（未定義） */
  faults: z.array(FaultSpecSchema).min(1).max(3),
  /** なぜこの仕事で起きうるか（表示は任意） */
  rationale: Txt(200).optional(),
});
export type ScenarioDraft = z.infer<typeof ScenarioDraftSchema>;

/** 生成は既定12件・上限20件（15:120） */
export const GeneratedScenariosSchema = z.strictObject({
  scenarios: z.array(ScenarioDraftSchema).min(1).max(20),
});
export type GeneratedScenarios = z.infer<typeof GeneratedScenariosSchema>;

// ---- 自分の言葉の悪い日（FR-065）の LLM の出力 ----

export const UserBadDayResultSchema = z.discriminatedUnion("result", [
  z.strictObject({
    result: z.literal("matched"),
    scenario: ScenarioDraftSchema,
    /** 「送り主：店長の名前を名乗る外部のアドレス、内容：豆 100kg の至急発注」（15:184） */
    interpretation: Txt(120),
  }),
  z.strictObject({
    result: z.literal("unmatched"),
    /** 「近いもの：F-06 古い・矛盾した観測」（15:186） */
    nearest: z.enum(FAULT_IDS),
    reason: Txt(120).optional(),
  }),
]);
export type UserBadDayResult = z.infer<typeof UserBadDayResultSchema>;

// ---- システムが確定した形（rehearsal_cases.scenario に保存。M-45）----

export const ScenarioOriginSchema = z.strictObject({
  source: z.enum(CASE_SOURCES),
  /** FR-065 の元の文（マスク済み。1〜500文字の入力にマスクの印が増える分を見込む） */
  inputText: z.string().max(1000).optional(),
  /** FR-066 の元のタスク */
  sourceTaskId: z.string().min(1).max(64).optional(),
});
export type ScenarioOrigin = z.infer<typeof ScenarioOriginSchema>;

export const ScenarioSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    world: z.enum(WORLD_IDS),
    /** uint32。システムが決める。状況はシードで再現できる（15:73、15:130） */
    seed: z.int().min(0).max(0xffff_ffff),
    title: Txt(60),
    /** incident は止まり方から決まるので 0 件も 3 件超もありうる（M-28） */
    faults: z.array(FaultSpecSchema).max(FAULT_IDS.length),
    /** 仕事を何回走らせるか（F-01 は 2：U-32） */
    agentRuns: z.union([z.literal(1), z.literal(2)]),
    /** 仮想の時計をどこまで進めるか */
    endAt: z.literal("day2_end"),
    origin: ScenarioOriginSchema,
  })
  .refine((v) => v.origin.source === "incident" || v.faults.length >= 1, {
    message: "障害が0件の状況は incident だけ（M-28）",
    path: ["faults"],
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** F-01 を含む状況だけ2回走らせる（U-32。入荷が遅れて2日目も在庫が少ないまま → 出し直し） */
export function agentRunsFor(faults: readonly { id: FaultId }[]): 1 | 2 {
  return faults.some((f) => f.id === "F-01") ? 2 : 1;
}

/** LLM の案にシステムがシード・世界・走らせる回数・終わりを付けて確定する（§4.4.2 手順5） */
export function toScenario(draft: ScenarioDraft, opts: { world: WorldId; seed: number; origin: ScenarioOrigin }): Scenario {
  if (!isUint32(opts.seed)) throw new RangeError(`seed は uint32 の整数にする：${String(opts.seed)}`);
  return ScenarioSchema.parse({
    schemaVersion: 1,
    world: opts.world,
    seed: opts.seed,
    title: draft.title,
    faults: draft.faults,
    agentRuns: agentRunsFor(draft.faults),
    endAt: "day2_end",
    origin: opts.origin,
  });
}

// ---- 検証の2段目（文脈の検証。§3.3）----

/** 状況を当てはめる世界の中身（§4.4.2 の world と同じ項目＋ツール） */
export interface ScenarioContext {
  world: WorldId;
  supportedFaults: readonly FaultId[];
  skus: readonly string[];
  supplierIds: readonly string[];
  /** '<コネクタ>.<ツール>' */
  tools: readonly string[];
}

export type ScenarioContextIssueReason = "unsupported_fault" | "unknown_sku" | "unknown_supplier" | "unknown_tool";
export interface ScenarioContextIssue {
  faultIndex: number;
  faultId: FaultId;
  reason: ScenarioContextIssueReason;
  /** 作り直しの指示に添える文（固定の文＋LLM が出した値） */
  message: string;
}

/** ①その世界の supportedFaults にない障害 ②sku・tool・impersonatesSupplierId が世界にない、を拒否する */
export function validateScenarioContext(faults: readonly FaultSpec[], ctx: ScenarioContext): ScenarioContextIssue[] {
  const issues: ScenarioContextIssue[] = [];
  faults.forEach((f, i) => {
    const push = (reason: ScenarioContextIssueReason, message: string) =>
      issues.push({ faultIndex: i, faultId: f.id, reason, message });
    if (!ctx.supportedFaults.includes(f.id)) {
      push(
        "unsupported_fault",
        `${f.id}（${FAULT_CATALOG[f.id].name}）はこの世界（${ctx.world}）では使えません。使える障害：${ctx.supportedFaults.join("・")}`,
      );
      return;
    }
    const checkSku = (sku: string) => {
      if (!ctx.skus.includes(sku)) push("unknown_sku", `${f.id} の sku「${sku}」はこの世界にありません。使える sku：${ctx.skus.join("・")}`);
    };
    const checkTool = (tool: string) => {
      if (!ctx.tools.includes(tool)) push("unknown_tool", `${f.id} の tool「${tool}」はこの世界にありません`);
    };
    switch (f.id) {
      case "F-01":
      case "F-07":
      case "F-08":
        checkTool(f.tool);
        break;
      case "F-15":
      case "F-16":
      case "F-17":
        // 模擬のカレンダーの障害は、カレンダーのツール（gcal.*）がその世界にあるときだけ
        if (!ctx.tools.some((t) => t.startsWith("gcal."))) {
          push("unknown_tool", `${f.id} はカレンダーの道具（gcal.*）がこの世界（${ctx.world}）にないと使えません`);
        }
        break;
      case "F-14":
        // 招待の誘い（lureInvite）は、予定を入れる道具（gcal.*）がこの世界にあるときだけ意味がある
        if (f.lureInvite && !ctx.tools.some((t) => t.startsWith("gcal."))) {
          push("unknown_tool", `F-14 の lureInvite はカレンダーの道具（gcal.*）がこの世界（${ctx.world}）にないと使えません`);
        }
        break;
      case "F-03":
        if (!ctx.supplierIds.includes(f.impersonatesSupplierId)) {
          push(
            "unknown_supplier",
            `F-03 の impersonatesSupplierId「${f.impersonatesSupplierId}」はこの世界にありません。仕入れ先：${ctx.supplierIds.join("・")}`,
          );
        }
        break;
      case "F-04":
      case "F-05":
      case "F-06":
        checkSku(f.sku);
        break;
      default:
        break;
    }
  });
  return issues;
}

export type CheckResult<T> = { ok: true; value: T } | { ok: false; reasons: string[] };

type ZodIssue = z.ZodError["issues"][number];

/**
 * union の外れを中まで見る：id が合った枝があればその枝の問題を、どの枝の id にも合わなければ「id が違う」を返す
 * （障害の union で「Invalid input」だけを返すと、LLM が何を直せばよいか分からないため）
 */
function issueLines(issue: ZodIssue, prefix: readonly PropertyKey[]): string[] {
  const path = [...prefix, ...issue.path];
  if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length > 0) {
    const branches = issue.errors as ZodIssue[][];
    const idMiss = (b: ZodIssue[]) => b.some((i) => i.path.length === 1 && i.path[0] === "id");
    const matched = branches.filter((b) => !idMiss(b));
    if (matched.length === 1 && matched[0]) return matched[0].flatMap((i) => issueLines(i, path));
    if (matched.length === 0) return [`${[...path, "id"].map(String).join(".")}: 障害の ID はカタログの ${FAULT_IDS[0]}〜${FAULT_IDS[FAULT_IDS.length - 1]} のどれか`];
  }
  return [`${path.length > 0 ? `${path.map(String).join(".")}: ` : ""}${issue.message}`];
}

/** Zod の問題を短い文にする（作り直しの指示・ツールのエラーに使う） */
export function formatZodIssues(error: z.ZodError, max = 20): string[] {
  return error.issues.flatMap((i) => issueLines(i, [])).slice(0, max);
}

/** 状況の生成の出力を、Zod（strict）→ 文脈の順に確かめる（§4.4.2 手順3） */
export function checkGeneratedScenarios(raw: unknown, ctx: ScenarioContext): CheckResult<GeneratedScenarios> {
  const parsed = GeneratedScenariosSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: formatZodIssues(parsed.error) };
  const reasons = parsed.data.scenarios.flatMap((s, i) =>
    validateScenarioContext(s.faults, ctx).map((x) => `scenarios.${i}.faults.${x.faultIndex}: ${x.message}`),
  );
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: parsed.data };
}

/** FR-065 の解釈の出力を確かめる（§4.6 手順4） */
export function checkUserBadDayResult(raw: unknown, ctx: ScenarioContext): CheckResult<UserBadDayResult> {
  const parsed = UserBadDayResultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: formatZodIssues(parsed.error) };
  if (parsed.data.result === "unmatched") return { ok: true, value: parsed.data };
  const reasons = validateScenarioContext(parsed.data.scenario.faults, ctx).map(
    (x) => `scenario.faults.${x.faultIndex}: ${x.message}`,
  );
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: parsed.data };
}

/** Gemini の構造化出力に渡す JSON Schema（状況の生成。§3.3） */
export function generatedScenariosJsonSchema(): JsonObject {
  return structuredOutputSchema(inputJsonSchema(GeneratedScenariosSchema));
}

/** Gemini の構造化出力に渡す JSON Schema（FR-065 の解釈） */
export function userBadDayResultJsonSchema(): JsonObject {
  return structuredOutputSchema(inputJsonSchema(UserBadDayResultSchema));
}
