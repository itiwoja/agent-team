// 依頼を送って、編成ができるまでの状態（送る・SSE の ask.*・10 秒/30 秒・取りこぼしの取り直し）。
// 入口・パックの作業場・全画面共通の「頼む」シートが同じ動きになるよう、ここに1つだけ持つ（純粋な畳み込みは lib/generation.ts）
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, describeError, type FormationView } from "../api";
import { askNoticePermission } from "../components/Notices";
import { useWorkspaceEvent } from "../workspace";
import { GIVE_UP_MS, SLOW_MS, askCreatedAfterGiveUp, generationReducer, initialGen, isGenerationEvent, type GenState } from "./generation";
import { navigate } from "./router";

export interface AskGeneration {
  state: GenState;
  /** 生成中・質問中（重ねて送れない） */
  busy: boolean;
  /** 送る。送れたら true（空・生成中は false） */
  submit: (text: string) => boolean;
  answer: (a: { choiceId: string } | { text: string }) => void;
  /** 見せ終わった・閉じたあとに、最初の状態へ戻す */
  reset: () => void;
  /** ask.formed（と引き直し）で分かった編成。askId ごと（担当の agentId は畳み込みの members に無い） */
  formations: Record<string, FormationView>;
}

export function useAskGeneration(opts: { packId?: string } = {}): AskGeneration {
  const { packId } = opts;
  const [state, dispatch] = useReducer(generationReducer, initialGen);
  const [formations, setFormations] = useState<Record<string, FormationView>>({});
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const askIdRef = useRef(state.askId);
  askIdRef.current = state.askId;
  const generationRef = useRef(0);

  // 依頼の事象（ask.*）。生成に関わる5種だけ畳み込む（ask.answered などは依頼のページ向けなので通さない）
  useWorkspaceEvent((type, data) => {
    if (!data || typeof data !== "object") return;
    const event = { ...(data as Record<string, unknown>), type };
    if (!isGenerationEvent(event)) return;
    if (event.type === "ask.formed" && (phaseRef.current === "generating" || phaseRef.current === "question")) {
      const { askId, formation } = event;
      setFormations((f) => ({ ...f, [askId]: formation }));
    }
    dispatch({ type: "event", event });
  });

  // 10 秒で「まだ考えています」、30 秒で打ち切り（質問に答えている間は数えない）。
  // 打ち切りの後も依頼はサーバーで作られ続けることがある。作られていれば失敗にせず依頼のページへ進む
  useEffect(() => {
    if (state.phase !== "generating") return;
    let cancelled = false;
    const generation = generationRef.current;
    const askId = state.askId;
    const slow = setTimeout(() => dispatch({ type: "slow" }), SLOW_MS);
    const giveUp = setTimeout(() => {
      void askCreatedAfterGiveUp(askId, (id) => api.ask(id)).then((id) => {
        if (cancelled || generationRef.current !== generation || askIdRef.current !== askId) return;
        const ph = phaseRef.current;
        if (id !== null && (ph === "generating" || ph === "question")) navigate(`/asks/${id}`);
        else dispatch({ type: "timeout" });
      });
    }, GIVE_UP_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(giveUp);
      cancelled = true;
    };
  }, [state.phase, state.askId]);

  // 事象を取りこぼしても追いつく（4 秒ごとに依頼を引き直す）
  useEffect(() => {
    if ((state.phase !== "generating" && state.phase !== "question") || !state.askId) return;
    const askId = state.askId;
    const id = setInterval(() => {
      api
        .ask(askId)
        .then((detail) => {
          const formation = detail.formation;
          if (formation) setFormations((f) => ({ ...f, [askId]: formation }));
          dispatch({ type: "detail", detail });
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(id);
  }, [state.phase, state.askId]);

  const submit = useCallback(
    (value: string): boolean => {
      const t = value.trim();
      if (!t || phaseRef.current === "generating" || phaseRef.current === "question") return false;
      // 終わったら知らせる（タブが裏にあるときのブラウザの通知）。頼んだ操作に合わせて1度だけ許可を聞く
      askNoticePermission();
      generationRef.current += 1;
      // 続けて呼ばれても重ならないよう、返事を待たずに phase を進めておく
      phaseRef.current = "generating";
      dispatch({ type: "submit", text: t });
      api
        .createAsk(t, undefined, packId ? { packId } : undefined)
        .then(({ ask }) => dispatch({ type: "accepted", ask }))
        .catch((e: unknown) => dispatch({ type: "error", message: describeError(e) }));
      return true;
    },
    [packId],
  );

  const answer = useCallback(
    (a: { choiceId: string } | { text: string }) => {
      const askId = askIdRef.current;
      if (!askId) return;
      dispatch({ type: "answered" });
      api.answerAsk(askId, a).catch((e: unknown) => dispatch({ type: "error", message: describeError(e) }));
    },
    [],
  );

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, busy: state.phase === "generating" || state.phase === "question", submit, answer, reset, formations };
}
