import { useEffect } from "react";

/**
 * シート・ドロワーを閉じたとき、開いたボタンにフォーカスを戻す。
 * マウント時の document.activeElement を覚え、アンマウント時に（まだ文書にあれば）focus() する。
 * 自分でフォーカスを動かす effect より前に呼ぶ（先に覚える）
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);
}
