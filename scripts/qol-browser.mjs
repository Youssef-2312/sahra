#!/usr/bin/env node
// Interaction checks against synthetic LOCAL fixtures only. Provide a local
// sessions JSON through SAHRA_TEST_SESSION_FILE; never use live session tokens.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin=process.env.SAHRA_TEST_ORIGIN||'http://localhost:8799';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname));
assert.ok(process.env.SAHRA_TEST_SESSION_FILE,'Provide synthetic local fixture sessions');
const sessions=JSON.parse(readFileSync(process.env.SAHRA_TEST_SESSION_FILE));
const output=process.env.SAHRA_SCREENSHOTS||'/tmp/sahra-qol';mkdirSync(output,{recursive:true});
const b=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
let flows=0;
try{
for(const lang of ['en','ar'])for(const width of [390,768,1440]){
 const c=await b.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
 await c.addInitScript(({lang,sessions})=>{localStorage.setItem('sahra_lang',lang);document.cookie=`__Host-sahra_s=${sessions.staff}; Secure; SameSite=Strict; Path=/`;document.cookie=`__Host-sahra_p=${sessions.platform}; Secure; SameSite=Strict; Path=/`;},{lang,sessions});
 const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await p.goto(origin+'/party');await p.locator('#form').waitFor();
 const reset=await p.evaluate(()=>Sahra.api.post('/api/tickets/form',{form:{questions:[],screenshot:'optional',id_photo:'none',instagram:'optional'}}));assert.equal(reset.ok,true);
 await p.reload();await p.locator('#form').waitFor();
 const name=p.locator('#basics [name=name]');await name.fill('Unsaved local draft');
 await p.locator('.lang-switch').click();assert.equal(await name.inputValue(),'Unsaved local draft','Switching language preserves unsaved staff fields');
 await p.locator('.lang-switch').click();assert.equal(await name.inputValue(),'Unsaved local draft');
 const key=k=>p.evaluate(k=>Sahra.t(k),k);
 await p.locator('#form').getByRole('button',{name:await key('s_q_add'),exact:true}).click();
 await p.locator('#form [name=q_label]').fill('Your picture / صورتك');await p.locator('#form [name=q_type]').selectOption('photo');await p.locator('#form [name=q_required]').check();
 const saveResponse=p.waitForResponse(r=>r.url().endsWith('/api/tickets/form')&&r.request().method()==='POST');await p.locator('#form').getByRole('button',{name:await key('s_save_form'),exact:true}).click();const response=await saveResponse;assert.equal(response.status(),200,(await response.text())+response.request().postData());await p.locator('#form .say.yes').waitFor();
 const saved=await p.evaluate(()=>Sahra.api.get('/api/tickets/form'));assert.equal(saved.body.form.questions[0].type,'photo');assert.equal(saved.body.form.questions[0].required,true);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);
 await p.locator('#form [name=q_type]').scrollIntoViewIfNeeded();await p.screenshot({path:output+`/settings-picture-${lang}-${width}.png`});
 await p.locator('#form [name=q_type]').click();await p.screenshot({path:output+`/dropdown-${lang}-${width}.png`});await p.keyboard.press('Escape');
 // Escape cancels the site's modal and returns focus to the originating control.
 await p.locator('#basics [name=name]').focus();await p.evaluate(()=>{window.dialogResult=null;Sahra.confirm('Local confirmation').then(v=>window.dialogResult=v);});
 await p.locator('dialog').waitFor();await p.keyboard.press('Escape');await p.waitForFunction(()=>window.dialogResult===false);assert.equal(await p.locator('#basics [name=name]').evaluate(e=>document.activeElement===e),true);
 // A blocked clipboard opens selected read-only text instead of reporting success.
 await p.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('local test'))}});document.querySelector('main').appendChild(Sahra.copyButton('LOCAL-ONLY','Local copy test'));});
 await p.getByRole('button',{name:'Local copy test',exact:true}).click();await p.locator('.dlg-input').waitFor();assert.equal(await p.locator('.dlg-input').inputValue(),'LOCAL-ONLY');assert.equal(await p.locator('.dlg-input').getAttribute('readonly'),'');await p.keyboard.press('Escape');await p.waitForFunction(()=>document.activeElement?.textContent==='Local copy test');
 if(lang==='en'&&width===390){await p.evaluate(()=>{window.testSay=SahraStaff.sayBox();document.querySelector('main').appendChild(window.testSay);SahraStaff.say(window.testSay,'yes','Saved');});await p.waitForFunction(()=>window.testSay.textContent==='');await p.evaluate(()=>SahraStaff.say(window.testSay,'no','Local error'));await p.waitForTimeout(3200);assert.equal(await p.evaluate(()=>window.testSay.textContent),'Local error');}
 await p.goto(origin+'/guests');await p.locator('input[name=q]').waitFor();
 await p.route('**/api/tickets/search?**',async r=>{const q=new URL(r.request().url()).searchParams.get('q');if(q==='Old')await new Promise(ok=>setTimeout(ok,500));await r.fulfill({contentType:'application/json',body:JSON.stringify({tickets:[{id:'0000000000000001',status:'pending',guest_name:q,people:1,created_at:Date.now(),answers:{}}]})});});
 await p.locator('input[name=q]').fill('Old');await p.locator('form[role=search] button[type=submit]').click();await p.getByRole('button',{name:await key('clear_search'),exact:true}).click();
 await p.locator('input[name=q]').fill('New');await p.locator('form[role=search] button[type=submit]').click();await p.locator('.g-name-line strong').waitFor();await p.waitForTimeout(650);assert.equal(await p.locator('.g-name-line strong').textContent(),'New','Stale search response must not replace the newer search');
 await p.getByRole('button',{name:await key('clear_search'),exact:true}).click();assert.equal(await p.locator('input[name=q]').inputValue(),'');assert.equal(await p.locator('.g-list').count(),0);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);assert.deepEqual(errors,[]);flows++;console.log(`PASS ${lang} ${width}: drafts, picture builder, dropdowns, modal/focus, clipboard fallback and search cancellation`);await c.close();
}
console.log(`PASS ${flows} quality-of-life browser flows`);
}finally{await b.close();}
