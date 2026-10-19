// GET /check を持ち、SSE（check.*）で畳み込む。○・選択肢で消した行はサーバーに反映されるまで隠す
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError, type CheckItem, type CheckResponse } from "../api";
import { useWorkspaceEvent } from "../workspace";
import { applyCheckEvent, sortCheckItems, withoutKeys } from "./order";

export function useCheck(focus: string | null) {
  const [data, setData] = useState<CheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // ○ が失敗した行の理由。行は隠すと作り直されるので、行の中ではなくここに持つ
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 取り直しの通し番号。後から出した要求の応答だけを採る（古い応答が新しいものを上書きしない）
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    return api
      .check(focus)
      .then((r) => {
        if (mine !== seq.current) return;
        setData({ ...r, items: sortCheckItems(r.items) });
        setError(null);
        // 隠した行のうち、サーバーの一覧からもう消えたキーは忘れる（いつまでも増えない。同じキーの行が後で来ても隠れない）
        setHidden((h) => {
          const alive = new Set([...h].filter((k) => r.items.some((i) => i.key === k)));
          return alive.size === h.size ? h : alive;
        });
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(describeError(e));
      });
  }, [focus]);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  useWorkspaceEvent((type, payload) => {
    if (type === "reset") return void load();
    if (!type.startsWith("check.")) return;
    // この事象より前に始まった GET は SSE の更新を巻き戻すため採用しない。
    // 最新状態は下の debounce による再取得で補う。
    seq.current++;
    if (type === "check.upsert" || type === "check.remove") setData((d) => (d ? { ...d, items: applyCheckEvent(d.items, type, payload) } : d));
    // 件数・やっていることは取り直す（事象は取りこぼしてもよい）
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  });

  /** 行を隠す（○・承認・回答のあと）。前の失敗の理由も消す */
  const hide = useCallback((key: string) => {
    setHidden((h) => new Set(h).add(key));
    setFailures((f) => {
      if (!f.has(key)) return f;
      const next = new Map(f);
      next.delete(key);
      return next;
    });
  }, []);
  /** 隠した行を戻す（○ がサーバーで失敗したとき）。理由を渡すと、その行に出す */
  const unhide = useCallback((key: string, message?: string) => {
    setHidden((h) => {
      if (!h.has(key)) return h;
      const next = new Set(h);
      next.delete(key);
      return next;
    });
    if (message !== undefined) setFailures((f) => new Map(f).set(key, message));
  }, []);
  const items: CheckItem[] = useMemo(() => (data ? withoutKeys(data.items, hidden) : []), [data, hidden]);
  return { data, items, error, failures, reload: load, hide, unhide };
}
