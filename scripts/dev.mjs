import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=process.env.npm_execpath;
if(!cli){console.error('Run with npm run dev.');process.exit(1);}
if(!existsSync(path.join(root,'contracts/deployments/localhost.json'))){
 console.error('Local deployment missing. In another terminal run npm run chain, then npm run deploy:local.');process.exit(1);
}
const children=['backend','frontend'].map(workspace=>spawn(process.execPath,[cli,'run','dev','--workspace',workspace],{cwd:root,stdio:'inherit',env:process.env}));
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill();setTimeout(()=>process.exit(code),250).unref();}
for(const child of children)child.on('exit',code=>{if(!stopping)stop(code??1)});
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
