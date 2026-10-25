import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/crypto";
import { api, harness, openParty, seedDoor, seedOwner, seedSession, signup, viewTicket } from "./helpers";
async function setup(){const h=await harness(),{party,os}=await openParty(h);const s=await signup(h,party,{name:"Rejected fixture"});expect(s.status).toBe(201);const id=s.body.ticket_id!;expect((await h.req('/api/tickets/reject',api(os,{ids:[id],reason:"Original rejection"}))).status).toBe(200);return {h,party,os,id,link:s.body.link!};}
const ticket=(id:string)=>env.DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(id).first();
describe('undo rejection',()=>{
 it('returns to pending once, clears stale approval/release/rejection metadata, keeps audit history and sends no email',async()=>{
  const {h,os,id,link}=await setup();const before=await ticket(id);const mail=await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox').first('n');
  await env.DB.prepare('UPDATE tickets SET approved_at = 1, released_at = 1 WHERE id = ?').bind(id).run();
  const op=newId();expect(await (await h.req(`/api/tickets/${id}/unreject`,api(os,{op}))).json()).toEqual({status:'done'});
  expect(await (await h.req(`/api/tickets/${id}/unreject`,api(os,{op}))).json()).toEqual({status:'already'});
  expect(await ticket(id)).toMatchObject({status:'pending',approved_at:null,approved_by:null,released_at:null,released_by:null,reject_reason:null,rejected_at:null,rejected_by:null,qr_version:Number(before!.qr_version)+1,last_action:'unrejected'});
  expect((await viewTicket(h,link)).body.ticket).toMatchObject({status:'pending',qr:null});
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox').first('n')).toBe(mail);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE entity_id = ? AND action = 'rejected'").bind(id).first('n')).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE entity_id = ? AND action = 'unrejected'").bind(id).first('n')).toBe(1);
  expect((await h.req(`/api/tickets/${id}/unreject`,api(os,{op:newId()}))).status).toBe(409);
 });
 it('requires owner/admin authorization, same party and CSRF, with invalid operations refused',async()=>{
  const {h,party,os,id}=await setup(),door=await seedDoor(party,h.clock);const other=await openParty(h);
  expect((await h.req(`/api/tickets/${id}/unreject`,api(door,{op:newId()}))).status).toBe(403);
  expect((await h.req(`/api/tickets/${id}/unreject`,api(other.os,{op:newId()}))).status).toBe(404);
  expect((await h.req(`/api/tickets/${id}/unreject`,{method:'POST',cookies:{'__Host-sahra_s':os.token},body:JSON.stringify({op:newId()})})).status).toBe(403);
  expect((await h.req(`/api/tickets/${id}/unreject`,api(os,{op:'bad'}))).status).toBe(400);
  const admin=await seedOwner(party,undefined,'admin'),as=await seedSession(party,admin.id,'admin',h.clock);
  expect((await h.req(`/api/tickets/${id}/unreject`,api(as,{op:newId()}))).status).toBe(200);
 });
 it('enforces party capacity under concurrent returns',async()=>{
  const {h,party,os,id}=await setup();const s=await signup(h,party);const second=s.body.ticket_id!;await h.req('/api/tickets/reject',api(os,{ids:[second]}));
  await env.DB.prepare('UPDATE parties SET capacity = 1 WHERE id = ?').bind(party).run();
  const rs=await Promise.all([id,second].map(i=>h.req(`/api/tickets/${i}/unreject`,api(os,{op:newId()}))));expect(rs.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ? AND status = 'pending'").bind(party).first('n')).toBe(1);
 });
 it('refuses cancelled parties, recovery holds, used records, refunds and exhausted ticket types',async()=>{
  const {h,party,os,id}=await setup();const refuse=async(error:string)=>expect(await (await h.req(`/api/tickets/${id}/unreject`,api(os,{op:newId()}))).json()).toEqual({error});
  await env.DB.prepare('UPDATE parties SET cancelled_at = 1 WHERE id = ?').bind(party).run();await refuse('party_cancelled');await env.DB.prepare('UPDATE parties SET cancelled_at = NULL WHERE id = ?').bind(party).run();
  await env.DB.prepare('UPDATE tickets SET hold_at = 1 WHERE id = ?').bind(id).run();await refuse('not_allowed');await env.DB.prepare('UPDATE tickets SET hold_at = NULL, used_at = 1 WHERE id = ?').bind(id).run();await refuse('not_allowed');await env.DB.prepare('UPDATE tickets SET used_at = NULL WHERE id = ?').bind(id).run();
  await env.DB.prepare("INSERT INTO refunds(ticket_id,party_id,amount,state,created_at,updated_at) VALUES(?,?,100,'due',1,1)").bind(id,party).run();await refuse('refund_recorded');await env.DB.prepare('DELETE FROM refunds WHERE ticket_id = ?').bind(id).run();
  const type='1111111111111111';await env.DB.prepare("INSERT INTO ticket_types(id,party_id,name,quantity,created_at) VALUES(?,?,'Full fixture',0,1)").bind(type,party).run();
  await env.DB.prepare('UPDATE ticket_types SET quantity = 0 WHERE id = ?').bind(type).run();await env.DB.prepare('UPDATE tickets SET type_id = ? WHERE id = ?').bind(type,id).run();await refuse('full');
  expect((await ticket(id))!.status).toBe('rejected');
 });
});
