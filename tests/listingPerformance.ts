import assert from 'node:assert/strict';
import { BaiduClient } from '../src/baidu/client';
import type { BaiduOAuthManager } from '../src/baidu/oauth';
import type { ListingOptions, ListingProgress } from '../src/baidu/client';
import { SyncFilter } from '../src/sync/filter';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { SyncEngine } from '../src/sync/engine';
import type { App } from 'obsidian';
import type { ManifestManager } from '../src/sync/manifest';

type Item = { path: string; isdir: number; fs_id?: number; size?: number };
const dir = (path: string): Item => ({path, isdir: 1});
const file = (path: string): Item => ({path, isdir: 0});
function fixture(tree: Record<string, Item[]>, delay = 10) {
  const client = new BaiduClient({refreshTokenIfNeeded: async () => 'offline'} as unknown as BaiduOAuthManager);
  let active = 0, peak = 0, requests = 0;
  const visited: string[] = [];
  Reflect.set(client, 'requestWithRetry', async (param: {url: string}) => {
    const u = new URL(param.url), path = u.searchParams.get('dir')!;
    active++; peak = Math.max(peak, active); requests++; visited.push(path);
    await new Promise(resolve => setTimeout(resolve, delay));
    active--;
    const start = Number(u.searchParams.get('start'));
    return {status: 200, json: {errno: 0, list: (tree[path] || []).slice(start, start + 1000)}};
  });
  return {client, visited, metrics: () => ({peak, requests, active})};
}
function list(client: BaiduClient, options: ListingOptions = {}, missing = false): Promise<Item[]> {
  return client.listAll('/vault', missing, options);
}
async function run() {
  const tree: Record<string, Item[]> = {'/vault': []};
  for(let i=0;i<12;i++) { const path = '/vault/d'+i; tree['/vault'].push(dir(path)); tree[path] = [file(path+'/note.md')]; }
  const f = fixture(tree);
  const started = performance.now();
  const result = await list(f.client, {concurrency: 3});
  console.log(JSON.stringify({case: '12 independent folders, 10ms/request', ...f.metrics(), elapsedMs: Math.round(performance.now()-started), files: result.length}));
  assert.equal(result.length, 12);
  assert.equal(f.metrics().peak, 3, 'remote listing must not serialize independent directories');
  assert.equal(f.metrics().active, 0);
  for(const [requested,expected] of [[1,1],[2,2],[100,3],[NaN,2],[0,1],[-1,1]]) {
    const g=fixture(tree,1); await list(g.client,{concurrency:requested}); assert.equal(g.metrics().peak,expected);
  }
  const filter = new SyncFilter({...DEFAULT_SETTINGS,syncPlugins:false,syncPluginIds:'baidu-pan-video-keys',ignoredPatterns:'**/.git/**\ncache/**\nnotes/*.md'},'.obsidian');
  const scoped: Record<string, Item[]> = {
    '/vault':[dir('/vault/.obsidian'),dir('/vault/.git'),dir('/vault/cache'),dir('/vault/notes')],
    '/vault/.obsidian':[dir('/vault/.obsidian/plugins'),dir('/vault/.obsidian/themes')],
    '/vault/.obsidian/plugins':[dir('/vault/.obsidian/plugins/baidu-pan-video-keys'),dir('/vault/.obsidian/plugins/other'),dir('/vault/.obsidian/plugins/baidu-netdisk-sync')],
    '/vault/.obsidian/plugins/baidu-pan-video-keys':[file('/vault/.obsidian/plugins/baidu-pan-video-keys/main.js')],
    '/vault/.obsidian/plugins/other':[file('/vault/.obsidian/plugins/other/main.js')],
    '/vault/.obsidian/plugins/baidu-netdisk-sync':[file('/vault/.obsidian/plugins/baidu-netdisk-sync/data.json')],
    '/vault/.obsidian/themes':[file('/vault/.obsidian/themes/theme.css')],
    '/vault/.git':[dir('/vault/.git/objects')],
    '/vault/.git/objects':[file('/vault/.git/objects/hidden')],
    '/vault/cache':[dir('/vault/cache/deep')],
    '/vault/cache/deep':[file('/vault/cache/deep/hidden')],
    '/vault/notes':[file('/vault/notes/test.md'),file('/vault/notes/test.pdf')]
  };
  const all=fixture(scoped,1),pruned=fixture(scoped,1);
  const a=await list(all.client), b=await list(pruned.client,{shouldSkipDirectory:p=>filter.shouldSkipDirectory(p)});
  const included=(items:Item[])=>items.filter(i=>!filter.shouldIgnore(i.path.slice(7))).map(i=>i.path).sort();
  assert.deepEqual(included(b),included(a),'pruning must preserve the original included file set');
  assert.ok(pruned.visited.includes('/vault/.obsidian/plugins'));
  assert.ok(pruned.visited.includes('/vault/.obsidian/plugins/baidu-pan-video-keys'));
  assert.ok(pruned.visited.includes('/vault/notes'),'file-only glob must not hide the PDF');
  for(const path of ['/vault/.git','/vault/cache','/vault/.obsidian/plugins/other','/vault/.obsidian/plugins/baidu-netdisk-sync']) assert.ok(!pruned.visited.includes(path));
  assert.ok(pruned.metrics().requests < all.metrics().requests);
  console.log(JSON.stringify({case:'scope pruning preserves selected plugins and PDF files',before:all.metrics().requests,after:pruned.metrics().requests}));
  const configOff=new SyncFilter({...DEFAULT_SETTINGS,syncObsidianConfig:false},'.obsidian');
  assert.equal(configOff.shouldSkipDirectory('.obsidian'),true);
  const noPlugins=new SyncFilter({...DEFAULT_SETTINGS,syncPlugins:false,syncPluginIds:'',syncThemes:false},'.obsidian');
  assert.equal(noPlugins.shouldSkipDirectory('.obsidian/plugins'),true);
  assert.equal(noPlugins.shouldSkipDirectory('.obsidian/themes'),true);
  assert.equal(filter.shouldSkipDirectory('个人笔记'),false);
  assert.equal(filter.shouldSkipDirectory('Schema/输入规则'),false);
  assert.equal(filter.shouldSkipDirectory('.trash'),true);
  const paged=fixture({'/vault':Array.from({length:1001},(_,i)=>file('/vault/f'+i))},1);
  const snapshots: ListingProgress[]=[];
  assert.equal((await list(paged.client,{onProgress:p=>snapshots.push(p)})).length,1001);
  assert.equal(paged.metrics().requests,2);
  assert.equal(snapshots.at(-1)?.directoriesScanned,1);
  assert.equal(snapshots.at(-1)?.requests,2);
  assert.equal(snapshots.at(-1)?.filesFound,1001);
  const short=fixture({},1); let pages=0;
  Reflect.set(short.client,'requestWithRetry',async()=>({status:200,json:++pages===1?{errno:0,list:[file('/vault/a')],has_more:1}:{errno:0,list:[file('/vault/b')],has_more:0}}));
  assert.equal((await list(short.client)).length,2);
  for(const bad of [null,{errno:0},{errno:0,list:[null]},{errno:0,list:[file('/outside/x')]},{errno:0,list:[dir('/vault/..')]},{errno:0,list:[file('/vault/a/b')]},{errno:0,list:[file('/vault/x\\y')]},{errno:0,list:[],has_more:1}]) {
    const g=fixture({},1); Reflect.set(g.client,'requestWithRetry',async()=>({status:200,json:bad})); await assert.rejects(list(g.client));
  }
  const duplicate=fixture({},1); let repeats=0;
  Reflect.set(duplicate.client,'requestWithRetry',async()=>({status:200,json:{errno:0,list:[file('/vault/a')],has_more:++repeats===1?1:0}}));
  await assert.rejects(list(duplicate.client),/重复路径/);
  const vanished=fixture({},1); let phase=0;
  Reflect.set(vanished.client,'requestWithRetry',async()=>({status:200,json:++phase===1?{errno:0,list:[file('/vault/a')],has_more:1}:{errno:-9}}));
  await assert.rejects(list(vanished.client,{},true),'a vanished root on page 2 is not a successful scan');
  const failure=fixture(tree,1); let live=0,peak=0;
  Reflect.set(failure.client,'requestWithRetry',async(param:{url:string})=>{
    const path=new URL(param.url).searchParams.get('dir');
    if(path==='/vault')return{status:200,json:{errno:0,list:[dir('/vault/d0'),dir('/vault/d1'),dir('/vault/d2')]}};
    live++;peak=Math.max(peak,live);await new Promise(resolve=>setTimeout(resolve,5));live--;
    return{status:200,json:path==='/vault/d0'?{errno:-9}:{errno:0,list:[]}};
  });
  await assert.rejects(list(failure.client,{concurrency:2},true));
  assert.equal(live,0,'no orphan requests may continue after the rejected scan');assert.equal(peak,2);
  const app={vault:{configDir:'.obsidian',adapter:{list:async()=>({files:[],folders:[]}),exists:async()=>false}}} as unknown as App;
  let saves=0,effects=0;
  const history={load:async()=>{},getAll:()=>({'keep.md':{path:'keep.md',mtime:1,size:1}}),save:async()=>{saves++;}} as unknown as ManifestManager;
  const settings={...DEFAULT_SETTINGS,accessToken:'offline',syncObsidianConfig:false,remoteBasePath:'/vault'};
  const engine=new SyncEngine(app,()=>settings,async()=>{},failure.client,history);
  Reflect.set(engine,'executePlanItem',async()=>{effects++;});
  assert.equal((await engine.startSync()).success,false);
  assert.equal(effects,0,'incomplete scan must not execute upload, download or deletion plans');
  assert.equal(saves,0,'incomplete scan must not advance history');
  assert.ok(engine.getLogs().some(e=>e.message.includes('云端检索未完成')));
  console.log('Listing concurrency, scope equivalence, pagination, malformed data, failure drain and no-side-effects tests: PASS');
}
run().catch(error=>{console.error(error);process.exitCode=1;});