/** Tab を枠の中で循環させる（シート・ドロワー共通） */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input,textarea,summary"));
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
