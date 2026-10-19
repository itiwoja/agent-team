// 入口の書きかけの文。ほかの画面へ移って戻っても、再読み込みしても消えないように、タブごと（sessionStorage）に残す。
// 送ったら消す。保存できない環境（プライベートモード・容量切れ）では、画面を移る間だけメモリに残す
const KEY = "makase:draft";

let memory = "";

export function readDraft(storage: Pick<Storage, "getItem"> | null = safeSession()): string {
  try {
    return storage?.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function writeDraft(text: string, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeSession()): void {
  memory = text;
  try {
    if (text.trim() === "") storage?.removeItem(KEY);
    else storage?.setItem(KEY, text);
  } catch {
    // 保存できなくても、メモリには残っている
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
