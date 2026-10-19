// 文字列とコメントの中の import は依存ではない：import pg from "pg"
export const prompt = `import pg from "pg"; await import("@google/genai"); require("node:fs")`;
export const note = 'import { x } from "@open-team/llm"';
