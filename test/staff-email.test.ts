import { env } from "cloudflare:test";
import { describe,expect,it } from "vitest";
import { newId } from "../src/lib/crypto";
import { api,harness,seedParty,seedOwner,seedSession,seedDoor } from "./helpers";
async function setup(){const h=await harness(),party=await seedParty(),owner=await seedOwner(party),os=await seedSession(party,owner.id,'owner',h.clock);const body={staff_id:newId(),invite_id:newId(),name:'Demo recipient',email:'invitefixture@gmail.com',role:'admin'};const invite=()=>h.req('/api/staff/google-invite',api(os,body));return {h,party,os,body,invite};}
const mails=async(party:string)=>(await env.DB.prepare("SELECT * FROM outbox WHERE party_id = ? AND kind = 'staff_invite'").bind(party).all()).results;
describe('team invitation emails',()=>{
 it('queues a bilingual sign-in email atomically once, including idempotent retries, and exposes delivery state',async()=>{
  const {h,party,os,body,invite}=await setup();expect((await invite()).status).toBe(200);expect((await invite()).status).toBe(200);
  const rows=await mails(party);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:body.invite_id,status:'queued',to_email:body.email,ticket_id:null});
  expect(rows[0]!.body_text).toContain('/signin');expect(rows[0]!.body_text).toContain(body.email);expect(rows[0]!.body_text).toContain('Google');expect(rows[0]!.body_text).toContain('تمت دعوتك');
  expect(String(rows[0]!.body_text)).not.toContain('token=');
  const list=await (await h.req('/api/staff',api(os,undefined,'GET'))).json() as {staff:{id:string;invitation_email_status:string|null}[]};
  expect(list.staff.find(s=>s.id===body.staff_id)?.invitation_email_status).toBe('queued');
  expect((await h.req('/api/staff/google-invite',api(os,{...body,staff_id:newId(),invite_id:newId()}))).status).toBe(409);expect(await mails(party)).toHaveLength(1);
 });
 it('resends legacy invitations, throttles queued/sent mail and safely retries after a failed delivery',async()=>{
  const {h,party,os,body,invite}=await setup();await invite();await env.DB.prepare('DELETE FROM outbox WHERE id = ?').bind(body.invite_id).run();
  const resend=(op:string)=>h.req(`/api/staff/${body.staff_id}/resend-invitation`,api(os,{op}));const op=newId();
  expect(await (await resend(op)).json()).toEqual({status:'queued'});expect(await (await resend(op)).json()).toEqual({status:'already_queued'});expect(await (await resend(newId())).json()).toEqual({status:'already_queued'});expect(await mails(party)).toHaveLength(1);
  await env.DB.prepare("UPDATE outbox SET status='failed',last_error='Fixture mailbox failure' WHERE id=?").bind(op).run();
  expect(await (await resend(newId())).json()).toEqual({status:'queued'});expect(await mails(party)).toHaveLength(2);
  h.clock.advance(600001);expect(await (await resend(newId())).json()).toEqual({status:'queued'});expect(await mails(party)).toHaveLength(3);
 });
 it('refuses non-owners, other parties, disabled/joined/expired/revoked invitations and invalid operations',async()=>{
  const {h,party,os,body,invite}=await setup();await invite();const door=await seedDoor(party,h.clock),admin=await seedOwner(party,undefined,'admin'),as=await seedSession(party,admin.id,'admin',h.clock);
  const other=await setup();const request=(session:typeof os,op=newId())=>h.req(`/api/staff/${body.staff_id}/resend-invitation`,api(session,{op}));
  expect((await request(door)).status).toBe(403);expect((await request(as)).status).toBe(403);expect((await request(other.os)).status).toBe(409);expect((await request(os,'bad')).status).toBe(400);
  await env.DB.prepare('UPDATE staff SET disabled_at=1 WHERE id=?').bind(body.staff_id).run();expect((await request(os)).status).toBe(409);
  await env.DB.prepare("UPDATE staff SET disabled_at=NULL,google_sub='fixture-sub' WHERE id=?").bind(body.staff_id).run();expect((await request(os)).status).toBe(409);
  await env.DB.prepare('UPDATE staff SET google_sub=NULL WHERE id=?').bind(body.staff_id).run();await env.DB.prepare('UPDATE invites SET revoked_at=1 WHERE id=?').bind(body.invite_id).run();expect((await request(os)).status).toBe(409);
  await env.DB.prepare('UPDATE invites SET revoked_at=NULL,expires_at=1 WHERE id=?').bind(body.invite_id).run();expect((await request(os)).status).toBe(409);expect(await mails(party)).toHaveLength(1);
 });
});
