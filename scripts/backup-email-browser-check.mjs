import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {projectAddress,readEditor,writeEditor} from './lib/backup-email-browser.mjs';
import {patchBackupAlerts} from './lib/backup-alerts.mjs';
const b=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,args:['--no-sandbox']});
try{const c=await b.newContext();await c.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://script.google.com'});
// Every request is intercepted: this does NOT access a real Google account or project.
await c.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Sahra backup fixture</title><div class="monaco-editor"><textarea class="inputarea"></textarea></div><script>window.saves=0;document.addEventListener("keydown",e=>{if(e.ctrlKey&&e.key.toLowerCase()==="s"){e.preventDefault();window.saves++}})</script>'}));
const project=projectAddress('https://script.google.com/home/projects/abcdefghijklmnopqrstuvwxyz123456/edit');
const p=await c.newPage();await p.goto(project.editor);const original=readFileSync(new URL('../backup/apps-script/Code.gs',import.meta.url),'utf8');await p.locator('textarea').fill(original);
assert.equal(await readEditor(p,project),original);
for(const mode of ['off','daily']){const code=patchBackupAlerts(original,mode);await writeEditor(p,project,code);assert.equal(await readEditor(p,project),code);}
assert.equal(await p.evaluate(()=>window.saves),2);
await p.goto('https://script.google.com/home/projects/differentproject123456789/edit');await assert.rejects(()=>readEditor(p,project));
await c.close();console.log('PASS browser editor copy/paste, exact read-back, save shortcuts, both alert modes and wrong-project refusal. All Google requests stubbed.');}finally{await b.close()}
