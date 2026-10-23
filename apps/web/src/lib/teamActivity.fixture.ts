// UI検証専用の架空データ。実行証拠として使用しない。
import type { AskDetail, StageView } from "../api";
export const modes = ["parallel", "waiting", "failed", "done", "retry", "approval", "many"] as const;
export type FixtureMode = typeof modes[number];
export function teamFixture(mode: FixtureMode): AskDetail {
  const stages: StageView[] = ["ことばの職人", "デザイン設計士", "まとめ博士"].map((agentName, i) => ({
    memberId: `member-${i}`, agentId: `agent-${i}`, agentName, position: i+1, isAggregator: i===2,
    summary: ["イベントの見出しと紹介文を考える", "色と配置を考え、スマホでも読める構成にする", "2人の報告をひとつの制作案にまとめる"][i]!,
    state: i===2 ? "waiting" : "running", stateText: i===2 ? "待っています" : "動いています", taskStatus: i===2 ? null : "running",
    taskId: i===2 ? null : `task-${i}`, report: null, tainted:false, isNew:true, reuseLine:"新しく作りました",
    startedAt: i===2 ? null : new Date(Date.now()-12000).toISOString(), finishedAt:null, activity:[], files:null,
  }));
  if(mode==="many") for(let i=3;i<6;i++) stages.push({...stages[0]!,memberId:`member-${i}`,agentId:`agent-${i}`,agentName:`追加エージェント${i-2}`,position:i+1,taskId:`task-${i}`,state:"waiting",taskStatus:null});
  if(mode==="waiting") stages.forEach(s=>Object.assign(s,{taskStatus:"queued",state:"running",stateText:"待っています",startedAt:null}));
  if(mode==="failed") Object.assign(stages[0]!,{state:"failed",taskStatus:"failed",stateText:"失敗：接続が切れました",finishedAt:new Date().toISOString()});
  if(mode==="approval") Object.assign(stages[0]!,{state:"awaiting_approval",taskStatus:"awaiting_approval",stateText:"確認待ち"});
  if(mode==="done") stages.forEach((s,i)=>Object.assign(s,{state:"done",taskStatus:"completed",taskId:`task-${i}`,stateText:"済み",finishedAt:new Date().toISOString(),report:{title:"制作案",body:"テスト用の報告です。実際のAI実行結果ではありません。"}}));
  if(mode==="done") stages[0]!.files={count:1,bytes:1024};
  if(mode==="retry") {
    Object.assign(stages[0]!,{state:"done",taskStatus:"completed",report:{title:"前段の完了報告",body:"テスト用"}});
    Object.assign(stages[1]!,{taskId:"retry-task",startedAt:new Date().toISOString(),activity:[{label:"作業場のファイルを見る",outcome:"done",at:new Date().toISOString()}]});
  }
  return {
    ask:{id:"fixture",text:"架空のAI体験会の告知ページをチームで考えてください",status:mode==="done"?"done":"running",shape:"aggregate",shapeLine:null,trigger:null,question:null,failure:null,answerPreview:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},
    formation:{shape:"aggregate",shapeLine:null,notes:[],members:stages.map((s,i)=>({memberId:s.memberId,agentId:s.agentId,agentName:s.agentName,isNew:true,summary:s.summary,position:s.position,dependsOn:i===2?[1,2]:[],isAggregator:i===2,isSpokesperson:i===2}))},
    run:{runId:mode==="retry"?"run-2":"run-1",runNo:mode==="retry"?2:1,status:mode==="done"?"done":"running",triggerType:"ask",startedAt:new Date().toISOString(),finishedAt:null},
    stages, handoffs:mode==="done"?[0,1].map(i=>({fromPosition:i+1,toPosition:3,fromAgentName:stages[i]!.agentName,toAgentName:stages[2]!.agentName,label:i===0?"見出しと紹介文の案":"配色と配置の案",taintMark:null})):[],
    answer:null,answerPending:null,pendingIntents:[],resume:null,messageCount:0,planner:null,
  };
}
