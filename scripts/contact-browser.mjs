#!/usr/bin/env node
// Local-only browser checks. Every FormSubmit request is fulfilled by a stub.
// Use PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE as in platform-browser.mjs.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.SAHRA_TEST_ORIGIN || 'http://localhost:8799';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname));
const output = process.env.SAHRA_SCREENSHOTS || '/tmp/sahra-contact';
mkdirSync(output,{recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,args:['--no-sandbox']});
const results=[];
try {
for (const lang of ['en','ar']) for (const width of [390,768,1440]) {
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
 await context.addInitScript(lang=>localStorage.setItem('sahra_lang',lang),lang);
 let requests=0, success=false;
 await context.route('https://formsubmit.co/**',async route=>{
  requests++;
  assert.equal(route.request().method(),'POST');
  const data=route.request().postDataJSON();
  assert.equal(data.email,'browser@example.test');
  assert.equal(data.date,lang==='ar'?'٢٤ أكتوبر ٢٠٢٦':'24 October 2026');
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success})});
 });
 const page=await context.newPage(), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(origin+'/contact');await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready);
 const form=page.locator('article:not([hidden]) form');
 const metrics=await form.evaluate(f=>{
  const rect=f.getBoundingClientRect(), button=f.querySelector('.wide-btn').getBoundingClientRect();
  const controls=[...f.querySelectorAll('.field input,.field select')];
  return {overflow:document.documentElement.scrollWidth-innerWidth,buttonLeftInset:button.left-rect.left,buttonRightInset:rect.right-button.right,
   heights:controls.map(e=>e.getBoundingClientRect().height),fontSizes:controls.map(e=>getComputedStyle(e).fontSize),
   controlStyles:[...controls,f.querySelector('textarea')].map(e=>{const s=getComputedStyle(e);return [s.borderRadius,s.border,s.backgroundColor,s.fontSize,s.padding].join('|');}),
   textareaHeight:f.querySelector('textarea').getBoundingClientRect().height,rows:f.querySelector('textarea').rows,
   hintSize:getComputedStyle(f.querySelector('.hint')).fontSize,footnoteSize:getComputedStyle(f.querySelector('.helper')).fontSize,
   linkHeights:[...f.parentElement.querySelectorAll('.msg-row')].map(e=>e.getBoundingClientRect().height),
   columnTopDifference:rect.top-f.parentElement.querySelector('.contact-intro').getBoundingClientRect().top};
 });
 assert.equal(metrics.overflow,0);assert.ok(metrics.buttonLeftInset>=20&&metrics.buttonRightInset>=20);
 assert.deepEqual(metrics.heights,[52,52,52,52,52]);assert.ok(metrics.fontSizes.every(s=>s==='16px'));
 assert.equal(new Set(metrics.controlStyles).size,1);assert.equal(metrics.rows,5);assert.equal(metrics.hintSize,'14px');assert.equal(metrics.footnoteSize,'14px');
 assert.ok(metrics.linkHeights.every(h=>h>=44));if(width===1440)assert.equal(metrics.columnTopDifference,0);
 await page.screenshot({path:`${output}/contact-${lang}-${width}.png`,fullPage:true});
 await form.locator('[name=name]').fill(lang==='ar'?'اختبار المتصفح':'Browser test');
 await form.locator('[name=email]').fill('browser@example.test');
 await form.locator('[name=date]').fill(lang==='ar'?'٢٤ أكتوبر ٢٠٢٦':'24 October 2026');
 await form.locator('[name=message]').fill('Local browser test. No real email.');
 await form.locator('.wide-btn').click();assert.equal(requests,0);
 await page.evaluate(()=>{window.open=url=>{window.testWhatsApp=url;return null;};});
 await form.locator('[data-via=whatsapp]').click();
 assert.ok((await page.evaluate(()=>window.testWhatsApp)).startsWith('https://wa.me/201119990639?text='));
 assert.equal(requests,0);
 await form.locator('[name=consent]').check();
 await form.locator('[name=_honey]').evaluate(e=>e.value='bot');
 await form.locator('.wide-btn').click();assert.equal(requests,0);
 await form.locator('[name=_honey]').evaluate(e=>e.value='');
 await form.locator('.wide-btn').click();await page.waitForLoadState('networkidle');assert.equal(requests,1);
 assert.equal(await form.locator('[name=email]').inputValue(),'browser@example.test');
 success=true;await form.locator('.wide-btn').click();await page.waitForLoadState('networkidle');assert.equal(requests,2);
 await page.waitForFunction(()=>document.querySelector('article:not([hidden]) [name=email]').value==='');assert.deepEqual(errors,[]);
 results.push({lang,width,...metrics,stubbedRequests:requests,errors});console.log(JSON.stringify(results.at(-1)));
 await context.close();
}
writeFileSync(`${output}/contact-measurements.json`,JSON.stringify(results,null,2));
} finally {await browser.close();}
