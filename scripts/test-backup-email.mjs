import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { patchBackupAlerts } from './lib/backup-alerts.mjs';
import { projectAddress } from './lib/backup-email-browser.mjs';
const code = readFileSync(new URL('../backup/apps-script/Code.gs', import.meta.url), 'utf8');
function runtime(mode, fail = false) {
  let now = Date.parse('2026-10-19T20:59:00Z');
  const data = new Map(), sent = [], logs = [];
  const props = {getProperty:k=>data.get(k),setProperty:(k,v)=>data.set(k,v)};
  const ctx = createContext({
    Date: class extends Date { static now(){return now;} }, props,
    MailApp:{sendEmail:(...args)=>{sent.push(args);if(fail)throw Error('mail unavailable')}},
    Session:{getScriptTimeZone:()=> 'Africa/Cairo',getEffectiveUser:()=>({getEmail:()=> 'owner@example.test'})},
    Utilities:{formatDate:(date,zone)=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;}},
    console:{log:s=>logs.push(s)},
  });
  runInContext(patchBackupAlerts(code, mode),ctx);
  return {data,sent,logs,advance:ms=>now+=ms,alert:kind=>runInContext(`alert_(props, ${JSON.stringify(kind)}, 'Problem', 'Details')`,ctx)};
}
test('off suppresses every custom alert without deleting triggers or calling backup services',()=>{
  const s=runtime('off');for(const kind of ['failed','stale','budget','files'])s.alert(kind);assert.equal(s.sent.length,0);assert.equal(s.data.size,0);
});
test('daily shares one limit across problems and resets at Cairo midnight',()=>{
  const s=runtime('daily');s.alert('failed');s.alert('stale');s.alert('budget');assert.equal(s.sent.length,1);s.advance(120000);s.alert('files');assert.equal(s.sent.length,2);assert.match(s.sent[0][2],/Sent by the Sahra backup script/);
});
test('email failures never throw or cause repeated attempts on the same day',()=>{
  const s=runtime('daily',true);assert.doesNotThrow(()=>s.alert('failed'));assert.doesNotThrow(()=>s.alert('stale'));assert.equal(s.sent.length,1);assert.equal(s.logs.length,1);
});
test('patch preserves all code outside alert_, supports switching again, and rejects unsafe sources',()=>{
  const remove=s=>s.replace(/^function alert_\(props, kind, subject, body\) \{[\s\S]*?^\}/m,'');
  const patched=patchBackupAlerts(code,'off');assert.equal(remove(patched),remove(code));assert.match(patchBackupAlerts(patched,'daily'),/var mode = 'daily'/);
  for(const bad of ['function myFunction() {}',code+'\n// Halloween-26',code+'\nGmailApp.sendEmail("x", "x", "x");',code.replace('function alert_(', 'function other_(')])assert.throws(()=>patchBackupAlerts(bad,'off'));
  assert.throws(()=>patchBackupAlerts(code,'weekly'));
});
test('project URL accepts only the actual Google editor host and a specific project',()=>{
  const id='abcdefghijklmnopqrstuvwxyz123456';
  assert.equal(projectAddress(`https://script.google.com/u/0/home/projects/${id}/edit`).triggers,`https://script.google.com/u/0/home/projects/${id}/triggers`);
  for(const bad of [`https://script.google.com.evil.test/home/projects/${id}/edit`,`https://script.google.com:8443/home/projects/${id}/edit`,`https://x@script.google.com/home/projects/${id}/edit`,`http://script.google.com/home/projects/${id}/edit`,'https://script.google.com/home/triggers'])assert.throws(()=>projectAddress(bad));
});
