// 手順1.2の内部口。未実装の判定・交代用の欄は受け付けない。
export type BrowserAction =
  | { kind: "screenshot" | "read_page" | "cursor_position" | "left_mouse_down" | "left_mouse_up" }
  | { kind: "mouse_move" | "left_click" | "right_click" | "middle_click" | "double_click" | "triple_click"; x: number; y: number }
  | { kind: "left_click_drag"; startX: number; startY: number; x: number; y: number }
  | { kind: "type" | "key"; text: string }
  | { kind: "hold_key"; text: string; duration: number }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amount: number; x?: number; y?: number }
  | { kind: "wait"; duration: number }
  | { kind: "open_url"; url: string };

export interface PageElement {
  role: string;
  name: string;
  center: { x: number; y: number };
  value?: string;
}

export interface ActionOutput {
  executed: true;
  text?: string;
  page?: PageElement[];
  screenshot?: { mimeType: "image/png"; data: string };
  cursor?: { x: number; y: number };
}

export interface BrowserBackend {
  ready(): boolean;
  sandboxEnabled: boolean;
  execute(action: BrowserAction): Promise<ActionOutput>;
  screenshot(): Promise<Buffer>;
}

export interface ActionRequest {
  actionId: string;
  controlEpoch: number;
  action: BrowserAction;
}

export class ValidationError extends Error {
  constructor() {
    // 入力の内容やURLを例外へ写さない。
    super("Invalid action request");
  }
}

function invalid(): never {
  throw new ValidationError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function coordinate(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return invalid();
  return value;
}

function point(value: Record<string, unknown>): { x: number; y: number } {
  return { x: coordinate(value.x, 1279), y: coordinate(value.y, 799) };
}

function duration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) return invalid();
  return value;
}

function keyText(value: unknown): string {
  // xdotoolのkeysymと「ctrl+shift+a」形式だけ。オプション・改行・複数コマンドを通さない。
  if (typeof value !== "string" || value.length > 128 || /[\x00\r\n]/.test(value) || !/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(value)) return invalid();
  return value;
}

export function parseBrowserAction(input: unknown): BrowserAction {
  const value = record(input);
  const kind = value.kind;
  switch (kind) {
    case "screenshot":
    case "read_page":
    case "cursor_position":
    case "left_mouse_down":
    case "left_mouse_up":
      keys(value, ["kind"]);
      return { kind };
    case "mouse_move":
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      keys(value, ["kind", "x", "y"]);
      return { kind, ...point(value) };
    case "left_click_drag":
      keys(value, ["kind", "startX", "startY", "x", "y"]);
      return { kind, startX: coordinate(value.startX, 1279), startY: coordinate(value.startY, 799), ...point(value) };
    case "type": {
      keys(value, ["kind", "text"]);
      if (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 16_000) return invalid();
      return { kind, text: value.text };
    }
    case "key":
      keys(value, ["kind", "text"]);
      return { kind, text: keyText(value.text) };
    case "hold_key":
      keys(value, ["kind", "text", "duration"]);
      return { kind, text: keyText(value.text), duration: duration(value.duration) };
    case "scroll": {
      keys(value, ["kind", "direction", "amount", "x", "y"]);
      const direction = value.direction;
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") return invalid();
      const amount = coordinate(value.amount, 100);
      if (amount === 0) return invalid();
      // 任意の座標はペアでのみ受け付ける。
      const position = Object.hasOwn(value, "x") || Object.hasOwn(value, "y") ? point(value) : {};
      return { kind, direction, amount, ...position };
    }
    case "wait":
      keys(value, ["kind", "duration"]);
      return { kind, duration: duration(value.duration) };
    case "open_url": {
      keys(value, ["kind", "url"]);
      if (typeof value.url !== "string" || value.url.length > 4096 || !/^https?:\/\//i.test(value.url) || /[\x00-\x20\x7f]/.test(value.url)) return invalid();
      try {
        const url = new URL(value.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") return invalid();
      } catch {
        return invalid();
      }
      return { kind, url: value.url };
    }
    default:
      return invalid();
  }
}

export function parseActionRequest(input: unknown): ActionRequest {
  const value = record(input);
  // dryRun:false/expect:nullも未対応。指定自体を拒否する。
  keys(value, ["actionId", "controlEpoch", "action"]);
  if (typeof value.actionId !== "string" || value.actionId.length < 1 || value.actionId.length > 128 || /[\s\x00-\x1f\x7f]/.test(value.actionId)) return invalid();
  if (typeof value.controlEpoch !== "number" || !Number.isSafeInteger(value.controlEpoch) || value.controlEpoch < 0) return invalid();
  return { actionId: value.actionId, controlEpoch: value.controlEpoch, action: parseBrowserAction(value.action) };
}
