import { readFileSync } from "node:fs";
export const golden = (p: string): string => readFileSync(p, "utf8");
