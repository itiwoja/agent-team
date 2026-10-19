// Google Calendar の REST の小さなクライアント（16 §2・§3.2）。fetch・基底 URL・アクセストークンは呼び出し側から受ける（試験は偽の fetch）。
// HTTP の結果は3つに分ける：401/403 → GoogleAuthError（HTTP 401 になる）、429・5xx・届かない → GoogleUpstreamError（同じ状態コード）、
// それ以外の4xx → GoogleApiError（ツールの結果 isError。409・404・410 は tools.ts が見る）

const REQUEST_TIMEOUT_MS = 10_000;
/** 一覧の上限（§3.1 list_events） */
const LIST_MAX_RESULTS = 50;
const LIST_MAX_PAGES = 4;

/** 認証の失敗（401・403）。gateway は auth_required にする */
export class GoogleAuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403) {
    super(`Google の認証に失敗（${status}）`);
    this.name = "GoogleAuthError";
    this.status = status;
  }
}

/** 一時的な失敗（429・5xx・届かない・タイムアウト）。同じ状態コードで返す（unknown_outcome の判定に乗る） */
export class GoogleUpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleUpstreamError";
    this.status = status;
  }
}

/** それ以外の4xx（409・404・410 を含む）。ツールごとに読む */
export class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Google Calendar が ${status} を返した`);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface FreeBusyCalendar {
  busy: BusyInterval[];
  errors?: Array<{ domain?: string; reason?: string }>;
}

export interface GcalEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** Google の予定（使うところだけ） */
export interface GcalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GcalEventTime;
  end?: GcalEventTime;
}

export interface EventInsertBody {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: Array<{ email: string }>;
}

export interface CalendarClient {
  /** 忙しい時間（予定の中身は返ってこない）。calendars の id ごと */
  freeBusy(timeMin: string, timeMax: string, calendarIds: readonly string[], timeZone: string): Promise<Record<string, FreeBusyCalendar>>;
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<{ events: GcalEvent[]; truncated: boolean }>;
  /** 招待の通知は送らない（sendUpdates=none） */
  insertEvent(calendarId: string, eventId: string, body: EventInsertBody): Promise<GcalEvent>;
  getEvent(calendarId: string, eventId: string): Promise<GcalEvent>;
  /** 通知は送らない（sendUpdates=none） */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export function createCalendarClient(fetchFn: typeof fetch, apiBase: string, accessToken: string): CalendarClient {
  const base = apiBase.replace(/\/+$/, "");

  async function call(method: string, url: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // 届かない・タイムアウト：送ったかどうか分からない（書き込みなら unknown_outcome）
      throw new GoogleUpstreamError(503, "Google Calendar に届かなかった");
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new GoogleAuthError(res.status);
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      throw new GoogleUpstreamError(res.status, `Google Calendar が ${res.status} を返した`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new GoogleApiError(res.status);
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      throw new GoogleUpstreamError(503, "Google Calendar の応答を読めなかった");
    }
  }

  const eventsUrl = (calendarId: string) => `${base}/calendars/${encodeURIComponent(calendarId)}/events`;

  return {
    async freeBusy(timeMin, timeMax, calendarIds, timeZone) {
      const json = (await call("POST", `${base}/freeBusy`, {
        timeMin,
        timeMax,
        timeZone,
        items: calendarIds.map((id) => ({ id })),
      })) as { calendars?: Record<string, FreeBusyCalendar> } | undefined;
      return json?.calendars ?? {};
    },

    async listEvents(calendarId, timeMin, timeMax) {
      const events: GcalEvent[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        const qs = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: String(LIST_MAX_RESULTS) });
        if (pageToken) qs.set("pageToken", pageToken);
        const json = (await call("GET", `${eventsUrl(calendarId)}?${qs.toString()}`)) as { items?: GcalEvent[]; nextPageToken?: string } | undefined;
        events.push(...(json?.items ?? []));
        pageToken = json?.nextPageToken;
        if (!pageToken) return { events, truncated: false };
      }
      return { events, truncated: pageToken !== undefined };
    },

    async insertEvent(calendarId, eventId, body) {
      const qs = new URLSearchParams({ sendUpdates: "none" });
      // id は Intent から決まる（§2-7）。呼び出し側の body に何が入っていても、ここで揃える
      return (await call("POST", `${eventsUrl(calendarId)}?${qs.toString()}`, { ...body, id: eventId })) as GcalEvent;
    },

    async getEvent(calendarId, eventId) {
      return (await call("GET", `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`)) as GcalEvent;
    },

    async deleteEvent(calendarId, eventId) {
      const qs = new URLSearchParams({ sendUpdates: "none" });
      await call("DELETE", `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}?${qs.toString()}`);
    },
  };
}
