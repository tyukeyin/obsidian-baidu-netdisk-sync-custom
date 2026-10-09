import assert from 'assert';
import { ChangeScheduler } from '../src/sync/changeScheduler';
async function test() {
  let busy = true, runs = 0;
  const wait = () => new Promise(r=>setTimeout(r,15));
  const scheduler = new ChangeScheduler(()=>true,()=>busy,async()=>{runs++;return {success:true};},()=>1);
  scheduler.changed(); scheduler.changed();
  await wait(); assert.equal(runs,0);
  busy=false; scheduler.idle(); await wait(); assert.equal(runs,1);
  scheduler.idle(); await wait(); assert.equal(runs,1);
  scheduler.changed(); scheduler.changed(); await wait(); assert.equal(runs,2);
  scheduler.changed(); scheduler.dispose(); await wait(); assert.equal(runs,2);
  let failedRuns=0;
  const failing = new ChangeScheduler(()=>true,()=>false,async()=>{failedRuns++;return {success:false};},()=>1);
  failing.changed();await wait();assert.equal(failedRuns,1);
  await wait();assert.equal(failedRuns,1,'no tight retry loop');
  failing.idle();await wait();assert.equal(failedRuns,2,'failure retained for next idle');failing.dispose();
  console.log('Change scheduling, busy edits, coalescing, disposal and retry retention passed');
}
test().catch(e=>{console.error(e);process.exitCode=1;});
