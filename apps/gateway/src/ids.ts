// ID の形（パスの ID は DB に投げる前に確かめる：uuid の列に形の違う文字列を渡すと SQL のエラーになる）

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID の文字列か（形の違う ID は「無い」として 404 にする） */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
