// Runs on the owner's Windows PC, using a separate browser profile outside the repo.
// Only the positively identified Sahra backup alert_ function is changed. No trigger is deleted.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { patchBackupAlerts, alertFunction } from './lib/backup-alerts.mjs';
import { projectAddress, readEditor, writeEditor } from './lib/backup-email-browser.mjs';

const ui = createInterface({ input: stdin, output: stdout });
const language = (await ui.question('Language / اللغة [en/ar]: ')).trim().toLowerCase() === 'ar' ? 'ar' : 'en';
const messages = {
  en: {
    intro: 'Sahra backup emails only. Backups and their hourly trigger stay running. Cloudflare is not changed.',
    mode: '1 Mute backup alert emails (recommended)\n2 At most one backup alert per calendar day\nChoice [1]: ',
    url: 'Paste the Sahra backup Apps Script editor URL: ',
    choose: 'Sign in yourself in the browser, then open this project\'s Code.gs. Do not select Halloween-26. Press Enter when ready: ',
    title: 'Check that this is your Sahra BACKUP project, not another script. Type SAHRA to continue: ',
    apply: 'Only alert_ will change. The original file is saved privately outside the repo. Type APPLY to save, or Enter to cancel: ',
    saved: 'The code was read back successfully. Wait for Google\'s Saved to Drive indicator, then press Enter to confirm it is saved: ',
    done: 'Saved. Your chosen email setting applies to the next backup run. No backup was run and no test email was sent.',
    google: 'If the email says Summary of failures, Google sends it separately. On this project\'s Triggers page, edit each backup trigger and set Failure notification settings to Notify me daily. Do not change its hourly backup cadence.',
    blocked: 'Could not finish automatic editing. Google may require a normal browser, or its editor may have changed. A replacement alert_ function was saved below. In your normal browser, replace only the existing alert_ function and save. Do not replace the entire script.',
    stopped: 'No change requested.', error: 'The helper stopped. No success is claimed. Check the browser and use the manual replacement if needed.',
  },
  ar: {
    intro: 'إعداد رسائل النسخ الاحتياطي لسهرة فقط. يستمر النسخ والمشغّل كل ساعة. لن تتغير إعدادات Cloudflare.',
    mode: '1 إيقاف رسائل تنبيه النسخ الاحتياطي (موصى به)\n2 رسالة تنبيه واحدة يوميًا كحد أقصى\nالاختيار [1]: ',
    url: 'الصق رابط محرر مشروع Apps Script للنسخ الاحتياطي لسهرة: ',
    choose: 'سجل الدخول بنفسك وافتح Code.gs في هذا المشروع. لا تختَر Halloween-26. اضغط Enter عندما تكون جاهزًا: ',
    title: 'تأكد أن المشروع هو النسخ الاحتياطي لسهرة وليس سكربتًا آخر. اكتب SAHRA للمتابعة: ',
    apply: 'ستتغير دالة alert_ فقط. تُحفظ نسخة من الملف الأصلي خارج المستودع. اكتب APPLY للحفظ أو Enter للإلغاء: ',
    saved: 'تمت إعادة قراءة الكود والتحقق منه. انتظر علامة الحفظ في Google ثم اضغط Enter لتأكيد الحفظ: ',
    done: 'تم الحفظ. يسري اختيارك من التشغيل التالي. لم نشغّل نسخة احتياطية ولم نرسل رسالة اختبار.',
    google: 'إذا كانت الرسالة بعنوان Summary of failures فهي من Google. في صفحة مشغّلات هذا المشروع عدّل إشعارات الفشل إلى Notify me daily. لا تغيّر توقيت النسخ كل ساعة.',
    blocked: 'تعذر إكمال التحرير الآلي. قد تطلب Google متصفحًا عاديًا أو يكون المحرر قد تغير. حُفظت دالة alert_ البديلة في المسار التالي. افتح المتصفح العادي واستبدل الدالة وحدها ثم احفظ. لا تستبدل السكربت كاملًا.',
    stopped: 'لم يُطلب أي تغيير.', error: 'توقف المساعد دون تأكيد النجاح. راجع المتصفح واستخدم الاستبدال اليدوي عند الحاجة.',
  },
}[language];
const root = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'Sahra', 'backup-email-helper');
let context;
try {
  console.log(messages.intro);
  const choice = (await ui.question(messages.mode)).trim();
  if (!['', '1', '2'].includes(choice)) throw new Error('Invalid choice');
  const mode = choice === '2' ? 'daily' : 'off';
  const project = projectAddress((await ui.question(messages.url)).trim());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manual = join(root, 'alert-function-' + mode + '.txt');
  await writeFile(manual, alertFunction(mode), { mode: 0o600 });
  try {
    const modulePath = process.env.PLAYWRIGHT_MODULE || join(root, 'node_modules', 'playwright', 'index.mjs');
    const { chromium } = await import(pathToFileURL(modulePath).href);
    for (const channel of ['chrome', 'msedge']) {
      try { context = await chromium.launchPersistentContext(join(root, 'browser'), { channel, headless: false }); break; }
      catch { /* Try another installed browser; no Google protections are bypassed. */ }
    }
    if (!context) throw new Error('Chrome or Edge required');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://script.google.com' });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(project.editor, { waitUntil: 'domcontentloaded' });
    await ui.question(messages.choose);
    if ((await ui.question(messages.title)).trim() !== 'SAHRA') { console.log(messages.stopped); process.exitCode = 0; }
    else {
      if (/hallowe?en[-_ ]?26/i.test(await page.title())) throw new Error('Protected project');
      const original = await readEditor(page, project);
      const patched = patchBackupAlerts(original, mode);
      if ((await ui.question(messages.apply)).trim() !== 'APPLY') console.log(messages.stopped);
      else {
        await writeFile(join(root, 'Code-' + project.id + '-' + Date.now() + '.gs.bak'), original, { mode: 0o600 });
        try { await writeEditor(page, project, patched); }
        catch (e) { try { await writeEditor(page, project, original); } catch { /* Leave browser open for recovery. */ } throw e; }
        await ui.question(messages.saved);
        const checked = await readEditor(page, project);
        if (checked.replace(/\r\n/g, '\n') !== patched.replace(/\r\n/g, '\n')) throw new Error('Saved editor content changed');
        await page.evaluate(() => navigator.clipboard.writeText(""));
        console.log(messages.done);
        console.log(messages.google);
        await page.goto(project.triggers, { waitUntil: 'domcontentloaded' });
      }
    }
  } catch {
    console.log(messages.blocked + '\n' + manual);
    console.log(project.editor);
    console.log(messages.google);
    process.exitCode = 1;
  }
  if (context) await ui.question(language === 'ar' ? 'اضغط Enter لإغلاق متصفح المساعد: ' : 'Press Enter to close the helper browser: ');
} catch {
  console.log(messages.error); process.exitCode = 1;
} finally {
  ui.close(); if (context) await context.close();
}
