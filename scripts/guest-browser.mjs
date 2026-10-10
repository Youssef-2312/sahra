#!/usr/bin/env node
// Local-only guest browser regression checks. APIs and Turnstile are stubbed;
// no real signup, upload, email or account is used. Optional external Playwright:
// PLAYWRIGHT_MODULE=/tmp/sahra-browser/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/usr/bin/chromium node scripts/guest-browser.mjs
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin=process.env.SAHRA_TEST_ORIGIN||'http://localhost:8799';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
const party={party:{id:'browser-party',name:'Browser party / حفلة تجريبية'},details:{name:'Browser party / حفلة تجريبية',starts_at:Date.now()+86400000,time_zone:'Africa/Cairo',rules:'Local entry rules',cancellation_policy:'Local cancellation policy',reveal:{mode:'manual'}},flyers:[],form:{questions:[{id:'note',type:'text',label:'Note / ملاحظة',required:true},{id:'agree',type:'choice',options:['Yes','No'],label:'Confirm / تأكيد',required:false},{id:'picture',type:'photo',label:'Your photo / صورتك',required:true}],screenshot:'optional',id_photo:'none',instagram:'optional'},max_people_per_ticket:4,places_left:40,full:false,registration:{open:true,state:'open'},max_tickets_per_email:5,types:[{id:'single',name:'Single / فردية',price:100,min_people:1,max_people:1,on_sale:true,places_left:40},{id:'group',name:'Group / مجموعة',price:80,min_people:2,max_people:4,on_sale:true,places_left:40}],policy:{terms_version:'v1',privacy_version:'v1',rules_version:'v1',email:false},turnstile_site_key:'local-test'};
let layoutChecks=0,flowChecks=0;
try {
for(const lang of ['en','ar'])for(const width of [390,768,1440]){
 const ctx=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
 await ctx.addInitScript(lang=>localStorage.setItem('sahra_lang',lang),lang);
 const errors=[],submissions=[];let reply='pending',ticketStatus='released';
 await ctx.route('https://challenges.cloudflare.com/**',r=>r.fulfill({contentType:'text/javascript',body:'window.turnstile={render:()=>"local",getResponse:()=>"test-token",reset:()=>{}};window.sahraTurnstileReady();'}));
 await ctx.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  const send=(body,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/me'||path==='/api/platform/me')return send({error:'not_signed_in'},401);
  if(path.endsWith('/signup')){
   const text=r.request().postData();
   const field=name=>new RegExp('name="'+name+'"\\r\\n\\r\\n([^\\r]*)').exec(text)?.[1];
   submissions.push({token:field('signup'),type:field('type_id'),tickets:field('tickets'),people:field('people'),names:field('names'),answers:field('answers'),consent:field('accept_terms'),photo:text.includes('name="q_picture"; filename=')});
   if(reply==='pending')return send({status:'pending'},503);
   if(reply==='terms')return send({error:'terms_changed',policy:{...party.policy,terms_version:'v2'},rules:'Updated rules'},409);
   return send({link:'/ticket.html#t=first',tickets:[{link:'/ticket.html#t=first',name:'Browser guest'},{link:'/ticket.html#t=second',name:'Friend'}]},201);
  }
  if(path==='/api/guest/ticket')return send({ticket:{guest_name:'Browser guest / ضيف',status:ticketStatus.startsWith('party-cancelled')?'released':ticketStatus,refund:ticketStatus.startsWith('party-cancelled')?{state:ticketStatus.endsWith('done')?'done':'due',amount:160}:null,qr:'S1.BROWSER.1234567890.1.ABCDEFG',people:1,type:'Single',used:ticketStatus==='used',on_hold:ticketStatus==='hold'},party:{id:'browser-party',name:party.party.name,starts_at:party.details.starts_at,time_zone:'Africa/Cairo',cancelled:ticketStatus.startsWith('party-cancelled')?{reason:'Local cancellation'}:null,reveal:{mode:'manual',waiting_for:'owner'}}});
  if(path==='/api/guest/find')return r.request().method()==='GET'?send({turnstile_site_key:'local-test'}):send({status:'sent'});
  if(path==='/api/guest/parties/browser-party')return send(party);
  throw new Error('Unexpected route '+path);
 });
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))errors.push(m.text());});
 await page.goto(origin+'/signup?party=browser-party');await page.locator('.buy-form').waitFor();await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);layoutChecks++;
 await page.locator('[name=name]').fill('Browser guest');await page.locator('.buy-form [name=email]').fill('browser@example.test');
 await page.locator('[name=type_id][value=group]').check();
 await page.locator('[name=tickets]').fill('2');await page.locator('[name=tickets]').dispatchEvent('change');
 await page.locator('[data-friend]').fill('Friend');await page.locator('[data-q=note]').fill('Keep this note');await page.locator('[data-q=agree]').selectOption('Yes');
 await page.locator('[name=instagram]').fill('@browser');await page.locator('[name=accept_terms]').check();

 assert.match(await page.locator('[data-o-total]').textContent(),/320/);
 await page.locator('[name=screenshot]').setInputFiles({name:'local.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64')});
 await page.locator('.lang-switch').click();await page.waitForLoadState('networkidle');await page.locator('.buy-form').waitFor();
 assert.equal(await page.locator('[name=screenshot]').evaluate(e=>e.files.length),0);
 assert.equal(await page.locator('.buy-form > .notice').textContent(),await page.evaluate(()=>Sahra.t('signup_reattach')));
 assert.equal(await page.locator('[name=name]').inputValue(),'Browser guest');
 assert.equal(await page.locator('[name=type_id]:checked').inputValue(),'group','Language switch must preserve chosen ticket type');
 assert.equal(await page.locator('[name=tickets]').inputValue(),'2');assert.equal(await page.locator('[name=people]').inputValue(),'2');
 assert.equal(await page.locator('[data-friend]').inputValue(),'Friend');assert.equal(await page.locator('[data-q=note]').inputValue(),'Keep this note');assert.equal(await page.locator('[data-q=agree]').inputValue(),'Yes');
 assert.equal(await page.locator('[name=accept_terms]').isChecked(),false,'Consent must not be restored');
 await page.locator('.buy-form button[type=submit]').click();assert.equal(submissions.length,0);
 await page.locator('[name="q_picture"]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64')});
 if(process.env.SAHRA_SCREENSHOTS){await page.locator('[name="q_picture"]').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.SAHRA_SCREENSHOTS+'/photo-question-'+lang+'-'+width+'.png'});}
 await page.locator('[name=accept_terms]').check();await page.locator('.buy-form button[type=submit]').click();await page.locator('[data-result] .notice').waitFor();
 assert.equal(submissions.length,1);reply='terms';await page.locator('.buy-form button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('[name=accept_terms]').checked);
 assert.equal(await page.locator('[name=name]').inputValue(),'Browser guest');
 assert.match(await page.locator('#party-rules').innerText(),/Updated rules/);
 reply='success';await page.locator('[name=accept_terms]').check();await page.locator('.buy-form button[type=submit]').click();await page.locator('.done-view').waitFor();
 assert.equal(new Set(submissions.map(s=>s.token)).size,1);assert.ok(submissions.every(s=>s.type==='group'&&s.tickets==='2'&&s.people==='2'&&s.consent==='yes'&&s.photo));
 assert.ok(submissions.every(s=>JSON.parse(s.answers).agree==='Yes'&&JSON.parse(s.answers).note==='Keep this note'));
 assert.equal(await page.locator('.ticket-list li').count(),2);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sahra_tickets')).length),2);flowChecks++;
 for(const status of ['released','pending','approved','rejected','cancelled','used','hold','party-cancelled-due','party-cancelled-done']){
  ticketStatus=status;await page.goto(origin+'/ticket?case='+status+'#t=first');await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.qr-box').count(),status==='released'?1:0,'Only a usable released ticket may show QR');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);layoutChecks++;
  if(status==='released'){
   const downloadPromise=page.waitForEvent('download');await page.locator('a[download]').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'sahra-ticket.png');
  }
 }
 await page.goto(origin+'/find');await page.locator('#find-email').waitFor();
 await page.locator('form button[type=submit]').click();await page.locator('.find-card .notice').waitFor();
 await page.locator('#find-email').fill('browser@example.test');
 await page.locator('.lang-switch').click();assert.equal(await page.locator('#find-email').inputValue(),'browser@example.test');
 await page.locator('form button[type=submit]').click();await page.locator('.find-card[role=status]').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);layoutChecks++;
 assert.deepEqual(errors,[]);console.log(`PASS ${lang} ${width}: signup, consent/retry, language draft, QR states and download`);await ctx.close();
}
console.log(`PASS ${layoutChecks} guest layouts, ${flowChecks} complete guest browser flows`);
}finally{await browser.close();}
