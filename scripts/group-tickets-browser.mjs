#!/usr/bin/env node
// Local-only split group ticket UI checks. All API requests and Turnstile are stubbed.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.SAHRA_TEST_ORIGIN || 'http://localhost:8799';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
const duo = { id: 'duo', name: 'Duo / ثنائي', price: 301, min_people: 2, max_people: 2, package: true,
  individual_tickets: true, on_sale: true, places_left: 40, held: 0, quantity: null };
const party = { party: { id: 'browser-party', name: 'Browser party / حفلة تجريبية' },
  details: { name: 'Browser party / حفلة تجريبية', starts_at: Date.now() + 86400000, time_zone: 'Africa/Cairo', reveal: { mode: 'manual' } },
  flyers: [], form: { questions: [], screenshot: 'none', id_photo: 'none', instagram: 'none' },
  max_people_per_ticket: 4, places_left: 40, full: false, registration: { open: true, state: 'open' },
  max_tickets_per_email: 5, types: [duo, { ...duo, id: 'shared', individual_tickets: false }],
  policy: { terms_version: 'v1', privacy_version: 'v1', rules_version: null, email: false }, turnstile_site_key: 'local-test' };
let checks = 0;
try {
  for (const lang of ['en', 'ar']) for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(lang => localStorage.setItem('sahra_lang', lang), lang);
    const errors = [], submissions = [];
    await context.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript',
      body: 'window.turnstile={render:()=>"local",getResponse:()=>"test-token",reset:()=>{}};window.sahraTurnstileReady();' }));
    await context.route('**/api/**', r => {
      const path = new URL(r.request().url()).pathname;
      const send = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/me' || path === '/api/platform/me') return send({ error: 'not_signed_in' }, 401);
      if (path === '/api/guest/parties/browser-party') return send(party);
      if (path.endsWith('/signup')) {
        submissions.push(r.request().postData());
        return send({ link: '/ticket#t=one', tickets: [{ link: '/ticket#t=one', name: 'Lead' }, { link: '/ticket#t=two', name: 'Friend' }] }, 201);
      }
      throw new Error('Unexpected API route: ' + path);
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text()); });
    await page.goto(origin + '/signup?party=browser-party');
    await page.locator('.buy-form').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-friend]').length === 1);
    await page.locator('[name=name]').fill('Lead');
    await page.locator('.buy-form [name=email]').fill('lead@example.test');
    await page.locator('[data-friend]').fill('Friend');
    assert.equal(await page.locator('[name=tickets]').isVisible(), false);
    assert.match(await page.locator('[data-o-total]').textContent(), /301/);
    assert.equal(await page.locator('[data-o-count]').textContent(), '2');
    await page.locator('[name=type_id][value=shared]').check();
    assert.equal(await page.locator('[data-friend]').count(), 0);
    assert.equal(await page.locator('[name=tickets]').isVisible(), true);
    await page.locator('[name=type_id][value=duo]').check();
    await page.locator('[data-friend]').fill('Friend');
    await page.locator('.lang-switch').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-friend]').length === 1);
    assert.equal(await page.locator('[data-friend]').inputValue(), 'Friend');
    await page.locator('.lang-switch').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-friend]').length === 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    if (process.env.SAHRA_SCREENSHOTS) await page.screenshot({ path: process.env.SAHRA_SCREENSHOTS + '/individual-duo-' + lang + '-' + width + '.png', fullPage: true });
    await page.locator('[name=accept_terms]').check();
    await page.locator('.buy-form button[type=submit]').click();
    await page.locator('.done-view').waitFor();
    assert.equal(submissions.length, 1);
    const field = key => new RegExp('name="' + key + '"\\r\\n\\r\\n([^\\r]*)').exec(submissions[0])?.[1];
    assert.equal(field('individual_tickets'), 'yes');
    assert.equal(field('people'), '2');
    assert.equal(field('tickets'), '1');
    assert.deepEqual(JSON.parse(field('names')), ['Friend']);
    assert.equal(await page.locator('.ticket-list li').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ lang, width, overflow: 0, tickets: 2, groupPrice: 301, errors: 0 }));
    checks++;
    await context.close();
  }
  for (const lang of ['en', 'ar']) for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(lang => localStorage.setItem('sahra_lang', lang), lang);
    const errors = [], saves = [];
    let individual = true;
    await context.route('**/api/**', r => {
      const path = new URL(r.request().url()).pathname;
      const send = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/me') return send({ csrf: 'local-test', staff: { name: 'Owner', role: 'owner' }, party: party.party });
      if (path === '/api/platform/me') return send({ error: 'not_signed_in' }, 401);
      if (path === '/api/party') return send({ id: 'browser-party', name: 'Browser party / حفلة تجريبية', time_zone: 'Africa/Cairo',
        capacity: 100, max_people_per_ticket: 4, admission_state: 'paused', location_mode: 'manual', emails: {} });
      if (path === '/api/tickets/types') return send({ types: [{ ...duo, individual_tickets: individual }] });
      if (path === '/api/tickets/types/duo') {
        const body = r.request().postDataJSON();
        saves.push(body); individual = body.individual_tickets;
        return send({ status: 'changed' });
      }
      if (path === '/api/tickets/form') return send({ form: party.form });
      if (path === '/api/party/flyers') return send({ flyers: [], max: 8 });
      throw new Error('Unexpected staff API route: ' + path);
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/party#types');
    await page.locator('.s-type-acts button').last().click();
    await page.locator('#type-editor').waitFor();
    const option = page.locator('[name=individual_tickets]');
    assert.equal(await option.isChecked(), true);
    await option.uncheck();
    await page.locator('#type-editor button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#type-editor'));
    assert.equal(saves.at(-1).individual_tickets, false);
    await page.locator('.s-type-acts button').last().click();
    await option.check();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    if (process.env.SAHRA_SCREENSHOTS) await page.screenshot({ path: process.env.SAHRA_SCREENSHOTS + '/individual-setting-' + lang + '-' + width + '.png', fullPage: true });
    await page.locator('#type-editor button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#type-editor'));
    assert.equal(saves.at(-1).individual_tickets, true);
    await page.locator('.s-type-acts button').first().click();
    assert.equal(await option.isChecked(), true, 'Copy preserves individual ticket delivery');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ lang, width, page: 'settings', overflow: 0, saves: saves.length, errors: 0 }));
    checks++;
    await context.close();
  }
} finally { await browser.close(); }
console.log('Individual group tickets: ' + checks + ' flows passed (local only).');
