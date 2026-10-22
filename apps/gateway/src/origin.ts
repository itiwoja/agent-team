// コネクタの URL の origin（判定の記録・資格情報の照合に使う。URL は origin だけを残す）

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** URL の origin（読めなければ null） */
export function originOf(url: string): string | null {
  return parse(url)?.origin ?? null;
}
