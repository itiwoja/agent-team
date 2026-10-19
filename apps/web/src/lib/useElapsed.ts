// 走っている間、始まりからの経過秒を1秒ごとに更新して返す（止まっている・始まりが分からないときは null）
import { useEffect, useState } from "react";

export function useElapsedSeconds(since: string | null | undefined, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, since]);
  if (!running || !since) return null;
  const t = new Date(since).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}
