// 文をクリップボードに写す（回答のコピー）。写せたら数秒「コピーしました」と言い、写せない環境（http・古いブラウザ）ではボタン自体を出さない
import { useCallback, useEffect, useRef, useState } from "react";

const SHOWN_MS = 2000;

export type CopyState = "idle" | "copied" | "failed";

/** クリップボードに書ける環境か（安全なオリジンで navigator.clipboard がある） */
export function canCopy(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function" && (typeof window === "undefined" || window.isSecureContext);
}

export function useCopy(): { state: CopyState; copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    clearTimeout(timer.current);
    navigator.clipboard
      .writeText(text)
      .then(() => setState("copied"))
      .catch(() => setState("failed"))
      .finally(() => {
        timer.current = setTimeout(() => setState("idle"), SHOWN_MS);
      });
  }, []);
  return { state, copy };
}

/** ボタンの文（状態ごと） */
export function copyLabel(state: CopyState): string {
  return state === "copied" ? "コピーしました" : state === "failed" ? "コピーできませんでした" : "コピー";
}
