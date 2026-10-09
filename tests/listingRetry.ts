import assert from 'node:assert/strict';
import type { RequestUrlResponse } from 'obsidian';
import { setRequestHandler } from './obsidianMock';
import { BaiduClient } from '../src/baidu/client';
import type { BaiduOAuthManager } from '../src/baidu/oauth';
import type { ListingProgress } from '../src/baidu/client';
const delayed = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
const requestedDelays: number[]=[];
Reflect.set(globalThis,'window',{setTimeout:(cb:()=>void,ms:number)=>{requestedDelays.push(ms);return setTimeout(cb,0);}});
function response(json:unknown,status=200): RequestUrlResponse {
  return {status,json,text:JSON.stringify(json),headers:{},arrayBuffer:new ArrayBuffer(0)};
}
async function run() {
  let token='old', forced=0, requests=0;
  const client=new BaiduClient({refreshTokenIfNeeded:async(force?:boolean)=>{
    if(force){forced++;await delayed(10);token='new';}return token;
  }} as unknown as BaiduOAuthManager);
  setRequestHandler(async param=>{
    requests++;const u=new URL(param.url),dir=u.searchParams.get('dir'),t=u.searchParams.get('access_token');
    if(dir==='/vault') return response({errno:0,list:Array.from({length:6},(_,i)=>({path:'/vault/t'+i,isdir:1}))});
    if(t==='old')return response({errno:-6});
    assert.equal(t,'new','retry must send refreshed token rather than retry stale URL');
    return response({errno:0,list:[]});
  });
  const progress:ListingProgress[]=[];
  assert.deepEqual(await client.listAll('/vault',false,{concurrency:2,onProgress:p=>progress.push(p)}),[]);
  assert.equal(forced,1,'concurrent invalid tokens must share one refresh');
  assert.equal(requests,9);
  assert.equal(progress.at(-1)?.requests,9);
  assert.equal(progress.at(-1)?.retries,2);
  const limited=new BaiduClient({refreshTokenIfNeeded:async()=>'offline'} as unknown as BaiduOAuthManager);
  let rateResponses=0,active=0,peak=0,calls=0;
  const afterRate: number[]=[];const snapshots:ListingProgress[]=[];
  setRequestHandler(async param=>{
    const dir=new URL(param.url).searchParams.get('dir');calls++;
    if(dir==='/vault')return response({errno:0,list:Array.from({length:6},(_,i)=>({path:'/vault/d'+i,isdir:1}))});
    active++;peak=Math.max(peak,active);await delayed(3);active--;
    if(dir==='/vault/d0'&&rateResponses++===0)return response({errno:31034});
    if(dir==='/vault/d0'&&rateResponses===2)return response({},429);
    if(Number(dir?.slice(-1))>=2) afterRate.push(active+1);
    return response({errno:0,list:[]});
  });
  await limited.listAll('/vault',false,{concurrency:2,onProgress:p=>snapshots.push(p)});
  assert.equal(active,0);assert.equal(peak,2);
  assert.ok(afterRate.every(n=>n===1),'subsequent directory batches must drop to 1 after rate limiting');
  assert.equal(snapshots.at(-1)?.concurrency,1);
  assert.equal(snapshots.at(-1)?.retries,2);
  assert.equal(snapshots.at(-1)?.requests,calls);
  assert.ok(requestedDelays.some(ms=>ms>=2000),'exponential backoff must remain in place');
  setRequestHandler(undefined);
  console.log('Real retry path: token refresh single-flight, refreshed URL, rate-limit downgrade, metrics and exponential backoff: PASS');
}
run().catch(error=>{setRequestHandler(undefined);console.error(error);process.exitCode=1;});