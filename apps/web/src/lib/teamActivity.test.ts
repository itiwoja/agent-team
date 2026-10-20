import {describe,it,expect} from "vitest";
import {isWorking,teamCounts,stageLabel,dependencies} from "./teamActivity";
import {teamFixture} from "./teamActivity.fixture";
describe("チームの実際の活動",()=>{
  it("実タスクのrunning/executingだけを同時稼働に数える",()=>{
    const d=teamFixture("parallel"); expect(teamCounts(d.stages).working).toBe(2);
    for(const taskStatus of ["queued","provisioning",undefined,null]) expect(isWorking({...d.stages[0]!,taskStatus})).toBe(false);
    expect(isWorking({...d.stages[0]!,taskStatus:"executing"})).toBe(true);
    expect(isWorking({...d.stages[0]!,state:"done"})).toBe(false);
  });
  it("順番待ちや確認待ちを並列と誤認しない",()=>{
    expect(teamCounts(teamFixture("waiting").stages)).toEqual({working:0,waiting:3,done:0,stopped:0});
    expect(teamCounts(teamFixture("approval").stages).working).toBe(1);
    expect(stageLabel(teamFixture("waiting").stages[0]!)).toBe("順番待ち");
  });
  it("失敗後も他担当の作業を表示し、完了と再実行を取り直す",()=>{
    expect(teamCounts(teamFixture("failed").stages)).toEqual({working:1,waiting:1,done:0,stopped:1});
    expect(teamCounts(teamFixture("done").stages).working).toBe(0);
    expect(teamCounts(teamFixture("retry").stages)).toEqual({working:1,waiting:1,done:1,stopped:0});
  });
  it("予定された依存と受領済みの記録を混ぜない",()=>{
    const d=teamFixture("parallel");expect(dependencies(d,d.stages[2]!)).toEqual(["ことばの職人","デザイン設計士"]);expect(d.handoffs).toHaveLength(0);
    expect(teamFixture("done").handoffs).toHaveLength(2);
  });
});
