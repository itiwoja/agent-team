// 外から入ってきた内容を「データ」として囲む（mcp-taint.md §3.10、formation-runtime.md §3.9）
// source は 'mcp:<slug>.<tool>'・'agent:<名前>'・'message:<名前>'・URL

const CLOSE_TAG = /<\/untrusted/gi;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 中の </untrusted を無害化してから <untrusted source="…">…</untrusted> で囲む */
export function wrapUntrusted(source: string, body: string): string {
  return `<untrusted source="${escapeAttr(source)}">\n${body.replace(CLOSE_TAG, "&lt;/untrusted")}\n</untrusted>`;
}
