import { env } from "cloudflare:test";
import { describe,expect,it } from "vitest";
import { insightCutoff } from "../src/guests/insights";
import { api,harness,seedParty,seedOwner,seedSession,seedDoor } from "./helpers";
async function setup(){const h=await harness(),party=await seedParty(),owner=await seedOwner(party),os=await seedSession(party,owner.id,'owner',h.clock);
 await env.DB.prepare('UPDATE parties SET guest_form=? WHERE id=?').bind(JSON.stringify({questions:[{id:'age',label:'Age / العمر',type:'text'},{id:'area',label:'Area',type:'choice',options:['Cairo','Giza']},{id:'picture',label:'Picture',type:'photo'}],screenshot:'optional'}),party).run();
 const rows=[['17','approved',1],['18','approved',1],['١٨','approved',1],['۱۹','approved',1],['١٨٫٥','approved',1],['18 years','approved',1],[null,'approved',1],['20','pending',1],['16','rejected',1],['18','approved',4]] as const;
 await env.DB.batch(rows.map((r,i)=>env.DB.prepare("INSERT INTO tickets(id,party_id,status,people,answers,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID().replace(/-/g,'').slice(0,16).toUpperCase(),party,r[1],r[2],JSON.stringify(r[0]===null?{}:{age:r[0],area:'Cairo'}),h.clock.now()+i)));
 const get=(q='')=>h.req('/api/party/form-insights?'+q,api(os,undefined,'GET'));return {h,party,os,get};}
describe('form answer analytics',()=>{
 it('validates comparison cutoffs',()=>{expect(insightCutoff(undefined)).toBe(18);expect(insightCutoff('18.5')).toBe(18.5);expect(insightCutoff('1e2')).toBe(100);for(const v of ['NaN','Infinity','18; DROP TABLE tickets','', '1e999','1000000000001'])expect(insightCutoff(v)).toBe(false);});
 it('counts recorded answers across all rows, normalizes Arabic digits, separates missing/invalid and does not inherit group answers',async()=>{
  const {get}=await setup();const r=await get('question=age&cutoff=18');expect(r.status).toBe(200);const b=await r.json() as {questions:{id:string}[];summary:Record<string,number|null>;answers:{answer:string;responses:number;places:number}[]};
  expect(b.questions.map(q=>q.id)).toEqual(['age','area']);expect(b.summary).toMatchObject({tickets:8,places:11,answered:7,answered_places:10,numeric_answers:6,below:1,equal:3,above:2,minimum:17,maximum:19});
  expect(b.answers.find(a=>a.answer==='18')).toMatchObject({responses:2,places:5});expect(b.answers.find(a=>a.answer==='18 years')).toMatchObject({responses:1});
  expect(b.summary.tickets).not.toBe(b.summary.places);
 });
 it('applies status and dates to summaries and breakdowns and never leaks another party',async()=>{
  const {h,get}=await setup();const other=await seedParty();await env.DB.prepare("INSERT INTO tickets(id,party_id,status,people,answers,created_at) VALUES('OTHERPARTY0000001',?,'approved',50,?,?)").bind(other,'{"age":"18"}',h.clock.now()).run();
  expect((await (await get('scope=pending')).json() as {summary:object}).summary).toMatchObject({tickets:1,above:1});
  expect((await (await get('scope=all')).json() as {summary:object}).summary).toMatchObject({tickets:10});
  const b=await (await get(`created_from=${h.clock.now()+1}&created_before=${h.clock.now()+3}`)).json() as {summary:object;answers:{responses:number}[]};expect(b.summary).toMatchObject({tickets:2,equal:2});expect(b.answers.reduce((n,a)=>n+a.responses,0)).toBe(2);
  for(const q of ['question=unknown','question=picture','question=age%22)%20OR%201=1','scope=bogus','cutoff=not-a-number','created_from=2&created_before=1'])expect((await get(q)).status).toBe(400);
 });
 it('supports categorical summaries and caps displayed distinct answers while totals cover all records',async()=>{
  const {party,get}=await setup();const categorical=await (await get('question=area')).json() as {summary:object;answers:object[]};expect(categorical.summary).toMatchObject({answered:7,numeric_answers:0});expect(categorical.answers).toEqual([{answer:'Cairo',responses:7,places:10}]);
  await env.DB.batch(Array.from({length:55},(_,i)=>env.DB.prepare("INSERT INTO tickets(id,party_id,status,answers,created_at) VALUES(?,?,'approved',?,1)").bind(crypto.randomUUID().replace(/-/g,'').slice(0,16).toUpperCase(),party,JSON.stringify({area:'Area '+i}))));
  const many=await (await get('question=area')).json() as {summary:{answered:number};answers:unknown[];truncated:boolean};expect(many.summary.answered).toBe(62);expect(many.answers).toHaveLength(50);expect(many.truncated).toBe(true);
 });
 it('requires owner/admin access and makes no data changes',async()=>{
  const {h,party,get}=await setup(),door=await seedDoor(party,h.clock);expect((await h.req('/api/party/form-insights',api(door,undefined,'GET'))).status).toBe(403);
  expect((await h.req('/api/party/form-insights')).status).toBe(401);
  const admin=await seedOwner(party,undefined,'admin'),as=await seedSession(party,admin.id,'admin',h.clock);expect((await h.req('/api/party/form-insights',api(as,undefined,'GET'))).status).toBe(200);
  const before=await env.DB.prepare('SELECT SUM(rev) AS n FROM tickets WHERE party_id=?').bind(party).first('n');await get();expect(await env.DB.prepare('SELECT SUM(rev) AS n FROM tickets WHERE party_id=?').bind(party).first('n')).toBe(before);
 });
});
