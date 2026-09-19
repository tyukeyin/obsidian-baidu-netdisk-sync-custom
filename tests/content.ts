import assert from 'assert';
import { SyncPlanner } from '../src/sync/planner';
const l={path:'a.md',mtime:9000,size:4,contentHash:'same'};
const r={path:'a.md',remotePath:'/v/a.md',mtime:10000,size:4,fsId:1,md5:'remote'};
const m={'a.md':{path:'a.md',remotePath:r.remotePath,mtime:1000,remoteMtime:2000,size:4,md5:'remote',contentHash:'same'}};
assert.equal(SyncPlanner.plan(new Map([['a.md',l]]),new Map([['a.md',r]]),m,'/v').length,0,'time-only changes must not transfer');
const changed={...l,mtime:1000,contentHash:'different'};
assert.equal(SyncPlanner.plan(new Map([['a.md',changed]]),new Map([['a.md',r]]),m,'/v')[0]?.action,'UPLOAD','same size and time content change must upload');
console.log('Content regression passed');
for (const policy of ['bidirectional','send','receive','mirrorSend','mirrorReceive'] as const) {
 assert.equal(SyncPlanner.plan(new Map([['a.md',l]]),new Map([['a.md',r]]),m,'/v',policy).length,0,policy+' ignores timestamps when hashes match');
}
const remoteChanged={...r,mtime:2000,md5:'new-content'};
assert.equal(SyncPlanner.plan(new Map([['a.md',l]]),new Map([['a.md',remoteChanged]]),m,'/v')[0]?.action,'DOWNLOAD');
