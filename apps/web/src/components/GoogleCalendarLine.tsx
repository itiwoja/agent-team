// Google カレンダーの接続の案内（16 §3.7）。つなぐ入口はメニュー（AppHeader）にあり、カレンダーの依頼なのに未接続のときは依頼の画面にも出す。
// この環境で使えないときは何も出さない。つなぐのは通常の画面遷移（同意画面へ行くため SPA の外へ出る）
import { useWorkspace } from "../workspace";

const DEFAULT_TIME_ZONE = "Asia/Tokyo";

/** ブラウザの時間帯（取れなければ既定）。サーバーは Intl で確かめ直す */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** つなぐ（同意画面へ行く。SPA の外への通常の遷移） */
export function connectHref(): string {
  return `/api/v1/connect/google/start?tz=${encodeURIComponent(browserTimeZone())}`;
}

/**
 * 依頼の画面の案内（16 §4）：カレンダーの依頼なのに未接続のとき、つなぐと予定まで入れられると伝える。
 * つながっている・この環境で使えないときは何も出さない
 */
export function GoogleCalendarHint({ needs }: { needs: "gcal" | "github" | null | undefined }) {
  const { google } = useWorkspace();
  if (needs !== "gcal" || !google.available || google.connected) return null;
  return (
    <p className="gcal-hint" role="note">
      Google カレンダーをつなぐと、予定まで入れられます{" "}
      <a className="gcal-link" href={connectHref()}>
        Google カレンダーをつなぐ
      </a>
    </p>
  );
}
