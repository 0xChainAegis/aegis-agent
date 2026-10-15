import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const children=[];let stopping=false;
function start(args,cwd=root,extra={}){const child=spawn(process.execPath,args,{cwd,env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',d=>{if(!String(d).includes('Private Key'))process.stdout.write(d)});child.stderr.on('data',d=>process.stderr.write(d));return child;}
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),600).unref();}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
async function waitFor(check){const until=Date.now()+45_000;while(Date.now()<until){try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('Local integration service did not become ready');}
const hardhat=path.join(root,'node_modules/hardhat/internal/cli/cli.js');
try{
 const chain=start([hardhat,'node','--hostname','127.0.0.1'],path.join(root,'contracts'));
 chain.on('exit',code=>{if(!stopping)stop(code??1)});
 await waitFor(async()=>{const r=await fetch('http://127.0.0.1:8545',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});return (await r.json()).result==='0x7a69'});
 const deployment=start([hardhat,'run','scripts/deploy-local.js','--network','localhost'],path.join(root,'contracts'));
 const code=await new Promise(resolve=>deployment.on('exit',resolve));if(code!==0)throw new Error('Local deployment failed');
 const backend=start(['--import','tsx','backend/src/index.ts'],root,{AEGIS_DB_PATH:path.join(root,'test-results',`chain-${Date.now()}.sqlite`)});
 backend.on('exit',code=>{if(!stopping)stop(code??1)});
 await waitFor(async()=>{const r=await fetch('http://127.0.0.1:3001/api/v1/health');return r.ok});
 const frontend=start([path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5173','--strictPort'],path.join(root,'frontend'));
 frontend.on('exit',code=>{if(!stopping)stop(code??1)});
 setInterval(()=>{},10_000);
}catch(error){console.error(error.message);stop(1);}
