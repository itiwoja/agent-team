import { X } from "./bad-cycle-x.tsx";
export function Y(props: { n: number }) {
  return <span>{props.n > 0 ? <X n={props.n - 1} /> : "end"}</span>;
}
