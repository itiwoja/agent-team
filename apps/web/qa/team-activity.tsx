import {useState} from "react";
import {createRoot} from "react-dom/client";
import {Stages} from "../src/screens/AskPage";
import {modes,teamFixture,type FixtureMode} from "../src/lib/teamActivity.fixture";
import "../src/styles.css";
import "../src/styles/ask.css";
import "../src/styles/avatar.css";
import "../src/styles/markdown.css";
function Preview(){
 const [mode,setMode]=useState<FixtureMode>("parallel");
 const labels={parallel:"並列作業",waiting:"待機",failed:"失敗",done:"完了",retry:"再実行",approval:"確認待ち",many:"6人"};
 return <div className="app"><main className="screen"><p style={{padding:12,background:"#fff0c2",color:"#503800",borderRadius:12,fontWeight:700}}>UIテスト用・架空データです。実際のAI実行ではありません。</p><nav aria-label="テスト状態" style={{display:"flex",flexWrap:"wrap",gap:8,margin:"16px 0"}}>{modes.map(m=><button type="button" key={m} className="btn btn-ghost" aria-pressed={mode===m} onClick={()=>setMode(m)}>{labels[m]}</button>)}</nav><Stages detail={teamFixture(mode)} messages={[]} /></main></div>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
