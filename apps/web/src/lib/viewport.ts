import { useEffect } from "react";

/** キーボードが開いても 1 文を隠さないよう、見えている高さを --app-h に入れる（iOS は layout viewport が縮まないため） */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    set();
    vv.addEventListener("resize", set);
    return () => {
      vv.removeEventListener("resize", set);
      document.documentElement.style.removeProperty("--app-h");
    };
  }, []);
}
