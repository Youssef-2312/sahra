#!/usr/bin/env node
// Browser regression checks for the organiser / site-owner UI. Start Wrangler
// locally first. API fixtures are intercepted in the browser; no account action
// or real email is possible. Playwright is an optional external test tool:
// npm install --prefix /tmp/sahra-browser playwright
// PLAYWRIGHT_MODULE=/tmp/sahra-browser/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/usr/bin/chromium node scripts/platform-browser.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.SAHRA_TEST_ORIGIN || 'http://localhost:8799';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a local development server only');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
const now = Date.now(), ownerId = '11111111-1111-4111-8111-111111111111';
const organiserId = '22222222-2222-4222-8222-222222222222';
const emptyParty = { id: 'browser-party', name: 'Browser party / حفلة المتصفح', capacity: 100, staff: 2, active_sessions: 1, admission_state: 'paused', no_active_owner: true, pending_owner_invites: 0, tickets: { pending: 2, approved: 3 }, outbox: { queued: 3 } };
const health = {
  checks: ['changelog', 'admissions', 'outbox', 'db_size', 'backup', 'usage'].map((id, i) => ({ id, status: ['ok', 'problem', 'unknown'][i % 3], checked_at: now, summary: 'Synthetic diagnostic report.' })),
  last_run_at: now, usage: { estimated_rows_written_today: 1234, daily_allowance: 100000, non_essential_stop_at: 50000 },
  discord: { status: 'configured', messages: { pending: 1, sent: 2 }, latest: { created_at: now, status: 'pending' } },
  alerts: [{ at: now, subject: 'Synthetic alert', statuses: { sent: 1 } }],
  party_usage_today: [{ party_id: 'browser-party', kind: 'signup', n: 2 }], limits: { signup: { cap: 1000 } },
};
let checks = 0;
async function fixture(role, lang = 'en', width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(lang => localStorage.setItem('sahra_lang', lang), lang);
  const page = await context.newPage(), errors = [], requests = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text()); });
  const state = { pending: false, mine: [], parties: [structuredClone(emptyParty)], organisers: [] };
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    requests.push(path);
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'POST') {
      assert.equal(req.headers()['x-sahra-csrf'], 'platform-test-csrf', 'Platform actions must use their own CSRF token');
      const body = req.postDataJSON(); posts.push({ path, body });
      if (state.pending) return send({ status: 'pending', retry: true }, 503);
      if (path === '/api/platform/parties') state.mine = [{ ...emptyParty, ...body }];
      if (path.endsWith('/disable')) state.parties[0].disabled_at = now;
      if (path.endsWith('/enable')) state.parties[0].disabled_at = null;
      if (path === '/api/platform/organisers') state.organisers.push({ id: body.organiser_id, name: body.name, email: body.email, party_limit: 1, active_parties: 0, linked: false });
      return send({ status: 'created' });
    }
    if (path === '/api/platform/me') return role === 'signed-out' ? send({ error: 'not_signed_in' }, 401) : send({
      site_owner: role === 'owner' ? { id: ownerId, name: 'Site owner' } : null,
      organiser: role === 'organiser' ? { id: organiserId, name: 'Organiser' } : null,
      csrf: 'platform-test-csrf', expires_at: now + 3600000,
    });
    const data = {
      '/api/platform/health': health,
      '/api/platform/organisers': { organisers: state.organisers, invites: [] },
      '/api/platform/parties': { parties: state.parties },
      '/api/platform/site-owners': { site_owners: [{ id: ownerId, name: 'Site owner', email: 'owner@example.test', linked: true }, { id: organiserId, name: 'Old access record', email: 'old@example.test', linked: false }] },
      '/api/platform/my-parties': { parties: state.mine },
      '/api/platform/teams': { teams: state.mine.map(p => ({ party_id: p.id, party_name: p.name, role: 'owner' })) },
    };
    assert.ok(path in data, `Unexpected API request: ${path}`);
    return send(data[path]);
  });
  await page.goto(origin + '/platform');
  await page.waitForLoadState('networkidle');
  return { page, context, errors, requests, posts, state };
}
try {
  for (const role of ['owner', 'organiser', 'signed-out']) for (const lang of ['en', 'ar']) for (const width of [390, 768, 1440]) {
    const f = await fixture(role, lang, width), { page } = f;
    await page.locator('details').evaluateAll(ds => ds.forEach(d => d.open = true));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${role} ${lang} ${width}: horizontal overflow`);
    assert.equal(await page.getAttribute('html', 'dir'), lang === 'ar' ? 'rtl' : 'ltr');
    assert.equal(await page.locator('#health').count(), role === 'owner' ? 1 : 0);
    assert.equal(f.requests.includes('/api/platform/health'), role === 'owner');
    assert.equal(f.requests.includes('/api/me'), false, 'Never load party authentication in this panel');
    assert.deepEqual(f.errors, []);
    if (role === 'owner') {
      assert.equal(await page.locator('.s-health-grid > li').count(), 6);
      assert.equal(await page.locator('#owners button').count(), 1, 'No remove-self action');
    }
    await f.context.close(); checks++;
  }
  console.log(`PASS ${checks} role/language/width combinations; health UI and API requests restricted to site-owner view`);

  const f = await fixture('organiser');
  await f.page.locator('#create [name=id]').fill('retry-party');
  await f.page.locator('#create [name=name]').fill('Retry party');
  f.state.pending = true;
  await f.page.locator('#create button').click();
  await f.page.waitForFunction(() => document.querySelector('#create button').textContent === Sahra.t('p_retry_action'));
  assert.equal(f.posts.length, 5);
  assert.equal(await f.page.locator('#create input[name=name]').isDisabled(), true);
  await f.page.locator('.lang-switch').click();
  f.state.pending = false;
  await f.page.locator('#create button').click();
  await f.page.locator('#mine .g-row').waitFor();
  assert.equal(f.posts.length, 6);
  for (const p of f.posts) assert.deepEqual(p.body, f.posts[0].body, 'Keep complete retry body and staff UUID across retries and language changes');
  assert.match(f.posts[0].body.staff_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.errors, []); await f.context.close();
  console.log('PASS pending create retries preserve request body and UUID, including manual retry after language change');

  const o = await fixture('owner');
  const party = o.page.locator('#parties .g-row').first();
  // Disabling (brainstorm idea 19): a panel with the effect in numbers; the party's name must be typed.
  await party.getByRole('button', { name: 'Disable party...', exact: true }).click();
  const confirmButton = party.getByRole('button', { name: 'Disable party', exact: true });
  assert.equal(await confirmButton.isDisabled(), true);
  assert.match(await party.locator('.s-disable').innerText(), /3 approved tickets cannot be used at the door/);
  await party.locator('.s-disable input').fill('wrong name');
  assert.equal(await confirmButton.isDisabled(), true);
  await party.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(o.posts.length, 0);
  await party.getByRole('button', { name: 'Disable party...', exact: true }).click();
  await party.locator('.s-disable input').fill(emptyParty.name);
  await party.getByRole('button', { name: 'Disable party', exact: true }).click();
  await party.getByRole('button', { name: 'Enable party', exact: true }).waitFor();
  o.page.once('dialog', d => d.accept());
  await party.getByRole('button', { name: 'Enable party', exact: true }).click();
  await party.getByRole('button', { name: 'Disable party...', exact: true }).waitFor();
  await party.locator('summary').click();
  await party.locator('[name=name]').fill('New local owner');
  await party.locator('[name=email]').fill('local.owner@gmail.com');
  await party.getByRole('button', { name: 'Invite new party owner', exact: true }).click();
  await party.locator('.say.yes').waitFor();
  const invite = o.posts.find(p => p.path.endsWith('/owner-invite'));
  assert.match(invite.body.staff_id, /^[0-9a-f-]{36}$/);
  assert.match(invite.body.invite_id, /^[0-9a-f-]{36}$/);
  o.page.once('dialog', d => d.dismiss());
  await o.page.getByRole('button', { name: 'Remove site owner', exact: true }).click();
  assert.equal(o.posts.some(p => p.path.endsWith('/remove')), false);
  o.page.once('dialog', d => d.accept());
  await o.page.getByRole('button', { name: 'Remove site owner', exact: true }).click();
  await o.page.locator('#owners .say.yes').waitFor();
  assert.ok(o.posts.some(p => p.path.endsWith('/remove')));
  assert.deepEqual(o.errors, []); await o.context.close();
  console.log('PASS party disable confirmation, re-enable, owner invitation and site-owner removal confirmation');
} finally {
  await browser.close();
}
