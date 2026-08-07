import type { WidgetDataContext } from "../../widget-runtime/src";

export interface CursorUsageData { cursorModelsPercent?: number; otherModelsPercent?: number; _stale?: boolean }
export interface CursorUsageConfig { secret_id:string; cache_minutes:number }
function normalizeSessionToken(value:string):string {
 return value.trim()
  .replace(/^WorkosCursorSessionToken=/i,"")
  .split(";")[0]!
  .replace(/\^%\^/g,"%")
  .replace(/\^%/g,"%");
}
export async function fetchData(context:WidgetDataContext,config:CursorUsageConfig):Promise<CursorUsageData>{
 const token=normalizeSessionToken(await context.services.getSecret(config.secret_id));
 return context.services.cachedProvider(`cursor:current-period:${config.secret_id}`,{ttlSeconds:config.cache_minutes*60,staleSeconds:86400},async()=>{
  const response=await context.services.request("https://cursor.com/api/dashboard/get-current-period-usage",{method:"POST",redirect:"manual",headers:{"Origin":"https://cursor.com","Accept":"application/json","Content-Type":"application/json"},secretCookies:{"WorkosCursorSessionToken":token},body:"{}"});
  if(response.status===401||response.status===403)throw new Error("TOKEN_EXPIRED");
  if(!response.ok)throw new Error(`CURSOR_HTTP_${response.status}`);
  const payload=await response.json() as {planUsage?:{autoPercentUsed?:unknown;apiPercentUsed?:unknown}};
  const cursor=payload.planUsage?.autoPercentUsed,other=payload.planUsage?.apiPercentUsed;
  if(typeof cursor!=="number"||typeof other!=="number")throw new Error("CURSOR_SCHEMA_CHANGED");
  return {cursorModelsPercent:cursor,otherModelsPercent:other};
 });
}
export function adaptData(data: CursorUsageData) {
  const percent=(value:unknown)=>{
    const number=Number(value);
    return (Number.isFinite(number)?number:0).toFixed(1);
  };
  return {cursorModelsPercent:percent(data.cursorModelsPercent),otherModelsPercent:percent(data.otherModelsPercent),staleMessage:data._stale?"Token/API error · cached data":""};
}
