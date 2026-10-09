// What the sign-in steps and "page not found" say, in English (the page's text
// before public/js/notice.js runs, and what tests read). notice.js has the same
// keys in English and Arabic (nt_<key>_t, nt_<key>) and shows them in the site's look.
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { page, type Notice } from "../lib/http";

export const NOTICES = {
  too_many: ["Too many attempts", "Too many sign-in attempts. Wait a minute and try again."],
  bad_origin: ["Sign-in failed", "This sign-in did not start on the Sahra site. Open the sign-in page and try again."],
  cancelled: ["Sign-in cancelled", "Sign-in was cancelled."],
  expired: ["Sign-in failed", "This sign-in did not start in this browser, or it expired. Start again."],
  not_verified: ["Sign-in failed", "Google sign-in could not be verified."],
  confirm_needed: ["Confirmation needed", "You were invited with an address that is not Gmail or Google Workspace. Such addresses must be confirmed by email, which is not available yet. Ask for an invitation to a Gmail address instead."],
  no_access: ["No access", "This Google account has not been invited to Sahra."],
  p_confirm_needed: ["Confirmation needed", "You were invited with an address that is not Gmail or Google Workspace. Such addresses must be confirmed by email, which is not available yet. Ask the site owner to invite a Gmail address instead."],
  p_no_access: ["No access", "This Google account is not a site owner or organiser."],
  capped: ["Too many sign-ins", "Too many sign-ins for this account in the last hour. Try again later."],
  changed: ["No access", "Access changed during sign-in. Try again."],
  pick_expired: ["Sign-in failed", "Party choice expired. Sign in again."],
  choose: ["Choose party", "Choose a party:"],
  signed_in: ["Signed in", "Signed in."],
  not_found: ["Page not found", "This page does not exist. Check the link, or go back to the parties."],
} as const satisfies Record<string, readonly [string, string]>;

export type NoticeKey = keyof typeof NOTICES;

export interface NoticeOpts extends Partial<Omit<Notice, "key" | "title" | "text">> {
  cookies?: string[];
}

/** An HTML page for a sign-in outcome (or not found), with its status and cookies. */
export function noticeResponse(c: Context<AppEnv>, status: number, key: NoticeKey, opts: NoticeOpts = {}) {
  const [title, text] = NOTICES[key];
  const { cookies = [], ...rest } = opts;
  const res = c.html(page({ key, title, text, ...rest }), status as 200);
  for (const ck of cookies) res.headers.append("set-cookie", ck);
  return res;
}
