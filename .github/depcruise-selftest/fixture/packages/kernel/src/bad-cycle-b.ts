import { a } from "./bad-cycle-a.ts";
export const b = (): number => (a.length > 0 ? 1 : 0);
