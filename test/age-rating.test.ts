import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseEdit } from "../src/party/input";
import { api, harness, seedDoor, seedOwner, seedParty, seedSession } from "./helpers";

describe("optional public age rating", () => {
  it("accepts a whole minimum age, all ages or clearing; rejects invalid values", () => {
    for (const age_rating of [null,"all","minimum:18","under:18","under:99"]) expect(parseEdit({age_rating})).toMatchObject({ok:true,values:{age_rating}});
    for (const age_rating of [-1,100,18.5,"18+","18","under:0","under:100","minimum:01","minimum:0","all:18",true,{},[],Infinity,NaN]) expect(parseEdit({age_rating})).toEqual({ok:false,error:"invalid_field:age_rating"});
  });
  it("saves with owner authorization, exposes the public label, preserves hidden addresses, and clears it", async () => {
    const h=await harness(),party=await seedParty(),other=await seedParty();
    const owner=await seedOwner(party),os=await seedSession(party,owner.id,"owner",h.clock);
    const door=await seedDoor(party,h.clock);
    const get=async()=> (await (await h.req(`/api/party/public/${party}`)).json()) as {age_rating:string|null;address:string|null};
    expect((await get()).age_rating).toBeNull();
    expect((await h.req('/api/party/details',api(door,{age_rating:"under:18"}))).status).toBe(403);
    expect((await h.req('/api/party/details',api(os,{age_rating:"under:18"}))).status).toBe(200);
    expect(await get()).toMatchObject({age_rating:"under:18",address:null});
    await env.DB.prepare("UPDATE parties SET starts_at = ? WHERE id = ?").bind(h.clock.now()+86400000,party).run();
    h.clock.advance(61000);
    const listing=await (await h.req('/api/guest/parties')).json() as {parties:{id:string;age_rating:string|null}[]};
    expect(listing.parties.find(p=>p.id===party)?.age_rating).toBe("under:18");
    const staff=await (await h.req('/api/party',api(os,undefined,"GET"))).json() as {age_rating:string};
    expect(staff.age_rating).toBe("under:18");
    expect((await (await h.req(`/api/party/public/${other}`)).json()) as object).toMatchObject({age_rating:null});
    expect((await h.req('/api/party/details',api(os,{age_rating:100}))).status).toBe(400);
    expect((await get()).age_rating).toBe("under:18");
    expect((await h.req('/api/party/details',api(os,{age_rating:"all"}))).status).toBe(200);
    expect((await get()).age_rating).toBe("all");
    expect((await h.req('/api/party/details',api(os,{age_rating:null}))).status).toBe(200);
    expect((await get()).age_rating).toBeNull();
  });
});
