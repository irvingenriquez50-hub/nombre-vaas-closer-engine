const statuses=new Set(['PENDING','APPROVED','REJECTED','IN_APPEAL','PAUSED','DISABLED','PENDING_DELETION']);
export function templateVerdict(result,name,language,expectedBody) {
  if(!Array.isArray(result?.templates)) throw new Error('No se pudo comprobar la aprobación de Meta.');
  const row=result.templates.find(t=>t.name===name && t.language===language);
  if(!row) return {status:'NOT_SUBMITTED',reason:null};
  const body=row.components?.find(c=>String(c.type).toLowerCase()==='body')?.text;
  if(expectedBody && body?.replace(/\r\n/g,'\n')!==expectedBody) return {status:'CONTENT_MISMATCH',reason:`La plantilla ${name} en Meta no coincide con el escrito de Closer. Revisa su contenido antes de activarla.`};
  return {status:statuses.has(row.status)?row.status:'UNKNOWN',reason:typeof row.reason==='string' && row.reason!=='NONE'?row.reason.slice(0,500):null};
}
export function publicApproval(connection) {
  const review=connection?.template_review;
  if(!connection?.account_id) return {opening:{status:'NOT_SUBMITTED'},followup:{status:'NOT_SUBMITTED'},checkedAt:null};
  if(review?.accountId!==connection.account_id) return {opening:{status:'UNKNOWN'},followup:{status:'UNKNOWN'},checkedAt:null};
  return {opening:review.opening,followup:review.followup,checkedAt:review.checkedAt};
}
