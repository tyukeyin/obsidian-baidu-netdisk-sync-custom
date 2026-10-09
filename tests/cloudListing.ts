import assert from 'assert';
import { BaiduClient } from '../src/baidu/client';
import type { BaiduOAuthManager } from '../src/baidu/oauth';
const client = new BaiduClient({refreshTokenIfNeeded:async()=>'offline'} as unknown as BaiduOAuthManager);
async function test() {
  const set = (json: unknown) => Reflect.set(client,'requestWithRetry',async()=>({status:200,json}));
  set({errno:-9}); await assert.rejects(client.listAll('/vault'));
  assert.deepEqual(await client.listAll('/vault',true),[]);
  set({errno:0}); await assert.rejects(client.listAll('/vault'));
  set({list:[]}); await assert.rejects(client.listAll('/vault'));
  set({errno:0,list:[]}); assert.deepEqual(await client.listAll('/vault'),[]);
  let calls=0;
  Reflect.set(client,'requestWithRetry',async()=>({status:200,json:++calls===1?{errno:0,list:[{isdir:1,path:'/vault/sub'}]}:{errno:-9}}));
  await assert.rejects(client.listAll('/vault',true),'a vanished child must not look like successful empty scan');
  console.log('Incomplete, missing and malformed remote listings stop sync');
}
test().catch(e=>{console.error(e);process.exitCode=1;});
