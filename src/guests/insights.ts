// Read-only summaries of recorded form answers. Ticket identity columns are not
// selected. A group answer is not inherited by its other members.
import { sessionValid,type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { raw,sql } from "../db/sql";
import type { DateRange } from "../lib/date-range";
export const INSIGHT_SCOPES = new Set(['approved','pending','all']);
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
export async function formInsights(driver:SqlDriver,sess:SessionRef,now:number,question:string,scope:string,cutoff:number,range:DateRange){
  const path='$."'+question+'"',ok=sessionValid(sess,['owner','admin'],now);
  const source=sql`WITH source AS (
    SELECT t.people,CASE WHEN json_type(CASE WHEN json_valid(t.answers) THEN t.answers ELSE '{}' END,${path}) IN ('text','integer','real')
      THEN trim(CAST(json_extract(CASE WHEN json_valid(t.answers) THEN t.answers ELSE '{}' END,${path}) AS TEXT)) ELSE NULL END AS answer
    FROM tickets t WHERE t.party_id=${sess.partyId} AND t.status IN ('pending','approved','rejected','cancelled')
      AND (${scope}='all' OR t.status=${scope}) AND ${ok}
      ${range.createdFrom!==undefined?sql`AND t.created_at>=${range.createdFrom}`:sql``}
      ${range.createdBefore!==undefined?sql`AND t.created_at<${range.createdBefore}`:sql``}
  ), normalized AS (SELECT people,answer,${normalized()} AS number_text FROM source), classified AS (
    SELECT *,CASE WHEN number_text GLOB '*[0-9]*' AND number_text NOT GLOB '*[^0-9.-]*'
      AND number_text NOT LIKE '%.%.%' AND instr(substr(number_text,2),'-')=0
      AND CAST(number_text AS REAL) BETWEEN -1e15 AND 1e15 THEN CAST(number_text AS REAL) END AS number_value FROM normalized
  )`;
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
