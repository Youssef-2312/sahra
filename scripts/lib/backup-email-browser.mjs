import { randomUUID } from 'node:crypto';

export function projectAddress(value) {
  const u = new URL(value);
  const match = /^\/(?:u\/\d+\/)?home\/projects\/([A-Za-z0-9_-]{20,})\/(?:edit|settings|triggers)\/?$/.exec(u.pathname);
  if (u.origin !== 'https://script.google.com' || u.username || u.password || !match) throw new Error('Use the Sahra Apps Script project editor URL');
  return { id: match[1], editor: u.origin + u.pathname.replace(/(?:settings|triggers)\/?$/, 'edit'), triggers: u.origin + u.pathname.replace(/(?:edit|settings|triggers)\/?$/, 'triggers') };
}

function assertProject(page, project) {
  const u = new URL(page.url());
  if (u.origin !== 'https://script.google.com' || !u.pathname.includes('/home/projects/' + project.id + '/')) throw new Error('The selected project is not open');
}

async function editor(page) {
  const editors = page.locator('.monaco-editor:visible');
  if (await editors.count() !== 1) throw new Error('Open only the Sahra backup Code.gs file in the editor');
  const area = editors.locator('textarea.inputarea');
  if (await area.count() !== 1) throw new Error('Cannot identify the Apps Script editor');
  return area;
}

export async function readEditor(page, project) {
  assertProject(page, project);
  await page.bringToFront();
  const area = await editor(page);
  // A sentinel prevents stale clipboard contents being mistaken for the selected source.
  const sentinel = 'sahra-backup-check-' + randomUUID();
  await page.evaluate(s => navigator.clipboard.writeText(s), sentinel);
  await area.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await page.waitForFunction(s => navigator.clipboard.readText().then(v => v !== s), sentinel, { timeout: 5000 });
  return page.evaluate(() => navigator.clipboard.readText());
}

export async function writeEditor(page, project, code) {
  assertProject(page, project);
  await page.bringToFront();
  const area = await editor(page);
  await page.evaluate(s => navigator.clipboard.writeText(s), code);
  await area.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+V');
  const value = await readEditor(page, project);
  if (value.replace(/\r\n/g, '\n') !== code.replace(/\r\n/g, '\n')) throw new Error('Editor read-back did not match');
  await page.keyboard.press('ControlOrMeta+S');
}
