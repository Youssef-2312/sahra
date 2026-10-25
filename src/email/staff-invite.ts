import type { OutboxRow } from "../outbox";
import { text } from "../party/input";
/** A generic sign-in URL grants nothing: Google must match the invited account. */
export function staffInvitation(a:{id:string;partyId:string;partyName:string;name:string;email:string;origin:string;expiresAt:number;now:number;actor:string}):OutboxRow {
  const party=text(a.partyName,80,false)||"Sahra",name=text(a.name,80,false)||"Guest";
  const link=new URL('/signin',a.origin).href,expires=new Date(a.expiresAt).toISOString();
  return {id:a.id,partyId:a.partyId,kind:'staff_invite',toEmail:a.email,now:a.now,createdBy:a.actor,needsApproval:false,
    subject:`Sahra team invitation | دعوة لفريق سهرة`,
    bodyText:`Hi ${name},\n\nYou have been invited to the team for ${party}.\n\nSign in here: ${link}\nUse this Google account: ${a.email}\nInvitation valid until (UTC): ${expires}\n\nNo password or invitation code is needed. Access is checked when you sign in. If you were not expecting this invitation, you can ignore this email.\n\nمرحبًا ${name}،\n\nتمت دعوتك إلى فريق ${party}.\n\nسجّل الدخول هنا: ${link}\nاستخدم حساب Google التالي: ${a.email}\nالدعوة صالحة حتى (UTC): ${expires}\n\nلا تحتاج إلى كلمة مرور أو رمز دعوة. تُراجع صلاحية الوصول عند تسجيل الدخول. إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل الرسالة.\n\nSahra | سهرة`};
}
