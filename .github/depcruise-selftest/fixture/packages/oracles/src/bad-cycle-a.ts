import { b } from "./bad-cycle-b.ts";
export const a = (): number => b() + 1;
