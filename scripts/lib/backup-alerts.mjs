// The browser helper edits only this function in a positively identified Sahra backup.
export function alertFunction(mode = 'daily') {
  if (!['off', 'daily'].includes(mode)) throw new Error('Invalid backup email mode');
  return `function alert_(props, kind, subject, body) {
  var mode = '${mode}'; // Sahra backup email preference: off or daily
  if (mode === 'off') { log_('Backup email alerts are off; see Executions for errors.'); return; }
  var day = dayOf_(Date.now());
  if (props.getProperty('SAHRA_ALERT_LAST_DAY') === day) return;
  // One attempt per calendar day across ALL problems, in the script time zone.
  props.setProperty('SAHRA_ALERT_LAST_DAY', day);
  var to = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  try {
    MailApp.sendEmail(to, subject, body + '\\n\\nSent by the Sahra backup script in this Google account (Apps Script).'
      + '\\nAt most one backup alert per day. Check Executions for later errors.'
      + '\\nتنبيه نسخ احتياطي واحد يوميًا كحد أقصى. راجع سجل التنفيذ للأخطاء التالية.');
  } catch (e) {
    // An email failure must not fail the backup or create another trigger-failure email.
    log_('Backup alert could not be sent; see Executions.');
  }
}`;
}

export function patchBackupAlerts(code, mode) {
  if (typeof code !== 'string' || /hallowe?en[-_ ]?26/i.test(code)) throw new Error('Not an eligible Sahra backup script');
  for (const marker of ['Sahra backup', 'function tick_(', 'function api_(', 'function dayOf_(', 'function log_(']) {
    if (!code.includes(marker)) throw new Error('Not an eligible Sahra backup script');
  }
  const functionPattern = /^function alert_\(props, kind, subject, body\) \{[\s\S]*?^\}/gm;
  const matches = [...code.matchAll(functionPattern)];
  if (matches.length !== 1) throw new Error('Cannot safely identify the backup alert function');
  const match = matches[0];
  if (!match[0].includes('MailApp.sendEmail')) throw new Error('Unrecognised backup alert function');
  const remaining = code.slice(0, match.index) + code.slice(match.index + match[0].length);
  if (/MailApp\.|GmailApp\./.test(remaining)) throw new Error('Other email code needs manual review');
  return code.slice(0, match.index) + alertFunction(mode) + code.slice(match.index + match[0].length);
}
