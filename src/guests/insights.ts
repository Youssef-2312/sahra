// Read-only summaries and owner/admin record drilldowns of recorded answers.
// Identity appears only in the drilldown. Group answers are not inherited.
import { sessionValid,type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { raw,sql,type Sql } from "../db/sql";
import type { DateRange } from "../lib/date-range";
export const INSIGHT_SCOPES = new Set(['approved','pending','rejected','cancelled','all']);
export function insightCutoff(value:string|undefined):number|false {
  if(value===undefined)return 18;
  if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(value))return false;
  const n=Number(value);return Number.isFinite(n)&&Math.abs(n)<=1e12 ? n : false;
}
function normalized(){
  let value='answer';
  const digits=['٠١٢٣٤٥٦٧٨٩','۰۱۲۳۴۵۶۷۸۹'];
  for(const alphabet of digits)for(let i=0;i<10;i++)value=`replace(${value},'${alphabet[i]}','${i}')`;
  return raw(`replace(${value},'٫','.')`);
}
export interface InsightFilters {type?:string;delivery?:string;entry?:string}
export const INSIGHT_OPERATORS=new Set(['below','at_most','equal','at_least','above','between','text_equal','contains','answered','missing','non_numeric']);
export const INSIGHT_GROUPS=new Set(['matching','non_matching','unknown','all']);
export const INSIGHT_SORTS=new Set(['newest','oldest','name','answer','number_asc','number_desc']);
export interface RecordSelection extends InsightFilters {operator:string;group:string;sort:string;value:string;upper:number;after?:string;q:string}
function insightSource(sess:SessionRef,now:number,question:string,scope:string,range:DateRange,filters:InsightFilters){
  const path='$."'+question+'"',ok=sessionValid(sess,['owner','admin'],now);
  return sql`WITH source AS (
    SELECT t.id,t.guest_name,t.status,t.created_at,t.order_id,t.type_id,t.released_at,t.used_at,t.hold_at,t.people,
      (SELECT name FROM ticket_types WHERE id=t.type_id AND party_id=t.party_id) AS type_name,CASE WHEN json_type(CASE WHEN json_valid(t.answers) THEN t.answers ELSE '{}' END,${path}) IN ('text','integer','real')
      THEN trim(CAST(json_extract(CASE WHEN json_valid(t.answers) THEN t.answers ELSE '{}' END,${path}) AS TEXT)) ELSE NULL END AS answer
    FROM tickets t WHERE t.party_id=${sess.partyId} AND t.status IN ('pending','approved','rejected','cancelled')
      AND (${scope}='all' OR t.status=${scope}) AND ${ok}
      ${range.createdFrom!==undefined?sql`AND t.created_at>=${range.createdFrom}`:sql``}
      ${range.createdBefore!==undefined?sql`AND t.created_at<${range.createdBefore}`:sql``}
      ${filters.type ? sql`AND t.type_id=${filters.type}`:sql``}
      ${filters.delivery === "released" ? sql`AND t.released_at IS NOT NULL`:filters.delivery === "unreleased" ? sql`AND t.released_at IS NULL`:sql``}
      ${filters.entry === "used" ? sql`AND t.used_at IS NOT NULL`:filters.entry === "unused" ? sql`AND t.used_at IS NULL`:sql``}
  ), normalized AS (SELECT *,${normalized()} AS number_text FROM source), classified AS (
    SELECT *,CASE WHEN number_text GLOB '*[0-9]*' AND number_text NOT GLOB '*[^0-9.-]*'
      AND number_text NOT LIKE '%.%.%' AND instr(substr(number_text,2),'-')=0
      AND CAST(number_text AS REAL) BETWEEN -1e15 AND 1e15 THEN CAST(number_text AS REAL) END AS number_value FROM normalized
  )`;
}

export async function formInsights(driver:SqlDriver,sess:SessionRef,now:number,question:string,scope:string,cutoff:number,range:DateRange,filters:InsightFilters={}){
  const source=insightSource(sess,now,question,scope,range,filters);
  const result=await driver.batch([
    sql`${source} SELECT COUNT(*) AS tickets,COALESCE(SUM(people),0) AS places,
      COUNT(CASE WHEN answer IS NOT NULL AND answer!='' THEN 1 END) AS answered,
      COALESCE(SUM(CASE WHEN answer IS NOT NULL AND answer!='' THEN people ELSE 0 END),0) AS answered_places,
      COUNT(number_value) AS numeric_answers,MIN(number_value) AS minimum,MAX(number_value) AS maximum,AVG(number_value) AS average,
      COUNT(CASE WHEN number_value<${cutoff} THEN 1 END) AS below,
      COUNT(CASE WHEN number_value=${cutoff} THEN 1 END) AS equal,
      COUNT(CASE WHEN number_value>${cutoff} THEN 1 END) AS above FROM classified`,
    sql`${source} SELECT answer,COUNT(*) AS responses,SUM(people) AS places FROM classified
      WHERE answer IS NOT NULL AND answer!='' GROUP BY answer ORDER BY responses DESC,answer LIMIT 51`
  ]);
  return {summary:result[0]!.results[0],answers:result[1]!.results.slice(0,50),truncated:result[1]!.results.length>50};
}

function criterion(operator:string,value:string,cutoff:number,upper:number):{match:Sql;known:Sql}{
 const answered=sql`answer IS NOT NULL AND answer!=''`,numeric=sql`number_value IS NOT NULL`;
 if(operator==='answered')return {match:answered,known:sql`1`};
 if(operator==='missing')return {match:sql`NOT (${answered})`,known:sql`1`};
 if(operator==='non_numeric')return {match:sql`number_value IS NULL AND ${answered}`,known:answered};
 if(operator==='text_equal')return {match:sql`answer=${value} COLLATE NOCASE`,known:answered};
 if(operator==='contains')return {match:sql`instr(lower(answer),lower(${value}))>0`,known:answered};
 const ops:Record<string,Sql>={below:sql`number_value<${cutoff}`,at_most:sql`number_value<=${cutoff}`,equal:sql`number_value=${cutoff}`,at_least:sql`number_value>=${cutoff}`,above:sql`number_value>${cutoff}`,between:sql`number_value BETWEEN ${cutoff} AND ${upper}`};
 return {match:ops[operator]!,known:numeric};
}
/** Match/non-match never silently classifies missing or invalid ages. */
export async function insightRecords(driver:SqlDriver,sess:SessionRef,now:number,question:string,scope:string,cutoff:number,range:DateRange,selection:RecordSelection){
 const c=criterion(selection.operator,selection.value,cutoff,selection.upper),source=insightSource(sess,now,question,scope,range,selection);
 const classified=sql`${source}, cohorts AS (SELECT *,CASE WHEN NOT (${c.known}) THEN 'unknown' WHEN ${c.match} THEN 'matching' ELSE 'non_matching' END AS cohort FROM classified)`;
 const like='%'+selection.q.replace(/[\\%_]/g,'\\$&')+'%',ref=/^SAH-([0-9A-Z]{1,16})$/i.exec(selection.q);
 const search=!selection.q?sql``:ref?sql`AND id LIKE ${ref[1]!.toUpperCase()+'%'}`:sql`AND (guest_name LIKE ${like} ESCAPE '\\' OR id LIKE ${like} ESCAPE '\\')`;
 const orders:Record<string,string>={newest:'created_at DESC,id DESC',oldest:'created_at,id',name:"COALESCE(guest_name,'') COLLATE NOCASE,id",answer:"COALESCE(answer,'') COLLATE NOCASE,id",number_asc:'number_value IS NULL,number_value,id',number_desc:'number_value IS NULL,number_value DESC,id'};
 const filtered=sql`${classified}, filtered AS (SELECT * FROM cohorts WHERE (${selection.group}='all' OR cohort=${selection.group}) ${search}),ordered AS (SELECT *,ROW_NUMBER() OVER (ORDER BY ${raw(orders[selection.sort]!)}) AS position FROM filtered)`;
 const result=await driver.batch([
  sql`${classified} SELECT COUNT(CASE WHEN cohort='matching' THEN 1 END) AS matching,COUNT(CASE WHEN cohort='non_matching' THEN 1 END) AS non_matching,COUNT(CASE WHEN cohort='unknown' THEN 1 END) AS unknown FROM cohorts`,
  sql`${filtered} SELECT COUNT(*) AS total FROM filtered`,
  sql`${filtered} SELECT id,guest_name,status,created_at,order_id,type_id,type_name,released_at,used_at,hold_at,people,answer,cohort FROM ordered
    WHERE position>COALESCE((SELECT position FROM ordered WHERE id=${selection.after || ''}),0) ORDER BY position LIMIT 21`
 ]);
 const rows=result[2]!.results.slice(0,20),last=rows.at(-1);
 return {counts:result[0]!.results[0],total:Number(result[1]!.results[0]?.total||0),records:rows,next:result[2]!.results.length>20&&last?String(last.id):null};
}
