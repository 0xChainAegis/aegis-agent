import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {loadConfig} from '../backend/src/config.js';
import {parseDraft} from '../backend/src/parser.js';
import {createLlmClient,StubIntentClient,parseDraftWithLlm,scanPrompt} from '../backend/src/llm.js';
const cases=JSON.parse(readFileSync('eval/intent-cases.json','utf8'));
const cfg=loadConfig();
const live=createLlmClient(cfg.llm)!;
const output='test-results/intent-eval-results.jsonl';
mkdirSync('test-results',{recursive:true});
writeFileSync(output,'');
const score=(draft:any,e:any)=>{
 const errors=[];
 if(draft.status!==e.status)errors.push('status');
 if(!(e.allowedRecipients??[e.recipient]).includes(draft.recipient))errors.push('recipient');
 if(!(e.allowedAmounts??[e.amountWei]).includes(draft.amountWei))errors.push('amountWei');
 if(e.questionRequired&&!draft.question)errors.push('question');
 return errors;
};
let done=0;
async function run(c:any,mode:string){
 const started=Date.now(); let raw:any=null,draft:any=null,error:any=null,rawErrors:any=null;
 try{
  if(mode==='rule')draft=parseDraft({message:c.message},null,c.previous??undefined);
  else {
   const config={...cfg,configuredModel:mode==='stub'?'stub-intent-v1':cfg.configuredModel,llm:{...cfg.llm,mode:mode==='stub'?'stub':'live'}} as any;
   const client=mode==='stub'?new StubIntentClient():live;
   const wrapped={provider:client.provider,model:client.model,extract:async(req:any)=>{raw=await client.extract(req); return raw;}};
   draft=await parseDraftWithLlm({message:c.message},config,c.previous??undefined,wrapped);
   if(raw){
    // 模型候选的独立投影：null 表示未提取；多轮未改动字段允许沿用前值。
    let amount=null;
    if(typeof raw.amountEth==='string'&&/^\d+(\.\d{1,18})?$/.test(raw.amountEth)){
     const [a,b='']=raw.amountEth.split('.'); amount=(BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0'))).toString();
    }
    const projected={status:raw.action==='transfer'?'DRAFT':'NEEDS_INPUT',recipient:raw.recipient??c.previous?.recipient??null,amountWei:amount??c.previous?.amountWei??null,question:raw.question};
    rawErrors=score(projected,c.expected);
   }
  }
 }catch(e){error=String(e);}
 const errors=draft?score(draft,c.expected):['exception'];
 const row={id:c.id,category:c.category,mode,testedAt:new Date().toISOString(),provider:mode==='live'?live.provider:mode==='stub'?'stub':null,model:mode==='live'?live.model:mode==='stub'?'stub-intent-v1':null,message:c.message,previous:c.previous,expected:c.expected,raw,rawErrors,draft,error,errors,correct:errors.length===0,latencyMs:Date.now()-started,promptBlocked:scanPrompt(c.message).blocked};
 appendFileSync(output,JSON.stringify(row)+'\n');
 done++; console.log(`${done}/120 ${mode} ${c.id} ${row.correct?'PASS':'FAIL:'+errors.join(',')} ${draft?.parser?.reason??error}`);
}
for(const c of cases){await run(c,'rule');await run(c,'stub');}
// 两个并发请求；逐条落盘。注入命中时由项目原有保护跳过真实 API，并计入回退。
let cursor=0;
await Promise.all([0,1].map(async()=>{while(cursor<cases.length){const c=cases[cursor++];await run(c,'live');}}));
console.log('Evaluation complete:',output);
