import { Y } from "./bad-cycle-y.tsx";
export function X(props: { n: number }) {
  return <div className="x">{props.n > 0 ? <Y n={props.n - 1} /> : null}</div>;
}
