/** 理由の文のうち、太字にする値（超えた値・宛先）で文を3つに分ける。値が文にないときは分けない */
export function splitEmphasis(text: string, emphasis: string | null): { before: string; strong: string; after: string } | null {
  if (!emphasis) return null;
  const i = text.indexOf(emphasis);
  if (i < 0) return null;
  return { before: text.slice(0, i), strong: emphasis, after: text.slice(i + emphasis.length) };
}
