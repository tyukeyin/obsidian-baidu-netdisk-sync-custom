import assert from 'assert';
import type { App } from 'obsidian';
import type { BaiduClient } from '../src/baidu/client';
import { SyncEngine } from '../src/sync/engine';
import { ManifestManager } from '../src/sync/manifest';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { md5 } from '../src/crypto/md5';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
type Entry = { data: ArrayBuffer; mtime: number };
let tick = 10000;
const cloud = new Map<string, Entry>();
const remoteEffects: string[] = [];
function device() {
  const files = new Map<string, Entry>();
  const folders = new Set(['']);
  let diskHistory = '';
  let failDownload = false;
  let failUpload = false;
  let failSave = false;
  const put = (path: string, text: string) => {
    const parts = path.split('/'); parts.pop();
    for (let i=1;i<=parts.length;i++) folders.add(parts.slice(0,i).join('/'));
    files.set(path,{data:bytes(text),mtime:tick+=2000});
  };
  const parent = (path: string) => path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '';
  const adapter = {
    exists: async (p: string) => p==='history' ? !!diskHistory : files.has(p)||folders.has(p),
    list: async (p: string) => ({files:[...files.keys()].filter(x=>parent(x)===p),folders:[...folders].filter(x=>x!==p&&parent(x)===p)}),
    stat: async (p: string) => files.has(p) ? {type:'file',size:files.get(p)!.data.byteLength,mtime:files.get(p)!.mtime} : folders.has(p) ? {type:'folder',size:0,mtime:0} : null,
    readBinary: async (p: string) => {if(!files.has(p)) throw Error('missing');return files.get(p)!.data;},
    writeBinary: async (p: string,data: ArrayBuffer) => {assert.ok(folders.has(parent(p)),'parent must exist');files.set(p,{data,mtime:tick+=2000});},
    mkdir: async (p: string) => {assert.ok(folders.has(parent(p)),'nested parent missing');folders.add(p);},
    trashLocal: async (p: string) => {files.delete(p);folders.delete(p);},
    rmdir: async (p: string) => {assert.ok(![...files.keys(),...folders].some(x=>x.startsWith(p+'/')));folders.delete(p);},
    read: async () => diskHistory,
    write: async (_: string, text: string) => {if(failSave)throw Error('disk full');diskHistory=text;}
  };
  const app = {vault:{adapter,configDir:'.obsidian',getAbstractFileByPath:()=>null}} as unknown as App;
  const client = {
    listAll: async () => [...cloud].map(([path,e])=>({path:'/vault/'+path,isdir:0,size:e.data.byteLength,server_mtime:e.mtime/1000,fs_id:path,md5:md5(new Uint8Array(e.data))})),
    deleteFiles: async (paths: string[]) => {for(const p of paths){remoteEffects.push('delete:'+p);cloud.delete(p.slice(7));}}
  } as unknown as BaiduClient;
  const settings = {...DEFAULT_SETTINGS,accessToken:'offline',remoteBasePath:'/vault',syncObsidianConfig:false};
  const manifest = new ManifestManager(app.vault.adapter,'history');
  const engine = new SyncEngine(app,()=>settings,async()=>{},client,manifest);
  Reflect.set(engine,'uploader',{uploadFile:async(path:string,data:ArrayBuffer)=>{
    if(failUpload)throw Error('upload interrupted');
    remoteEffects.push('upload:'+path);cloud.set(path.slice(7),{data,mtime:tick+=2000});
    return {mtime:tick/1000,size:data.byteLength,md5:md5(new Uint8Array(data)),fs_id:path.slice(7)};
  }});
  Reflect.set(engine,'downloader',{downloadByFsId:async(id:string)=>{if(failDownload)throw Error('offline');return cloud.get(id)!.data;}});
  return {files,folders,put,engine,fail:(v:boolean)=>{failDownload=v;}, failSend:(v:boolean)=>{failUpload=v;}, failHistory:(v:boolean)=>{failSave=v;}};
}
async function run() {
  const a=device(),b=device();
  a.put('old/note.md','same content');
  assert.equal((await a.engine.startSync()).success,true);
  assert.equal((await b.engine.startSync()).success,true);
  a.put('new/deep/note.md','same content');a.files.delete('old/note.md');
  a.failSend(true);
  assert.equal((await a.engine.startSync()).success,false);
  assert.ok(cloud.has('old/note.md'),'failed upload keeps cloud old path');
  a.failSend(false);
  assert.equal((await a.engine.startSync()).success,true);
  b.fail(true);
  assert.equal((await b.engine.startSync()).success,false);
  assert.ok(b.files.has('old/note.md'),'failed new-path download must retain old copy');
  b.fail(false);
  assert.equal((await b.engine.startSync()).success,true,'retry must populate nested new directory');
  assert.ok(b.files.has('new/deep/note.md'));
  assert.ok(!b.files.has('old/note.md'));
  assert.ok(!b.folders.has('old'),'obsolete empty directory removed');
  b.put('personal/new.md','not uploaded yet');
  a.files.delete('new/deep/note.md');
  await a.engine.startSync();await b.engine.startSync();
  assert.ok(!b.files.has('new/deep/note.md'));
  assert.ok(b.files.has('personal/new.md'));
  assert.ok(cloud.has('personal/new.md'));
  // Structure moves in the reverse direction as well.
  b.put('renamed/note.md','not uploaded yet');b.files.delete('personal/new.md');
  b.failHistory(true);
  assert.equal((await b.engine.startSync()).success,false);
  assert.ok(cloud.has('personal/new.md'),'history write failure blocks deletion');
  b.failHistory(false);
  assert.equal((await b.engine.startSync()).success,true);
  assert.equal((await a.engine.startSync()).success,true);
  assert.ok(a.files.has('renamed/note.md'));
  assert.ok(!cloud.has('personal/new.md'));
  console.log('Two-device migration, interrupted download retry, deletion and independent additions passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
