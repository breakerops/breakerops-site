import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const json=(body:unknown,status=200)=>Response.json(body,{status});
Deno.serve(async(req)=>{
 const key=Deno.env.get('REMINDERS_KEY');
 if(!key||req.headers.get('x-reminders-key')!==key)return json({error:'unauthorized'},401);
 if(req.method!=='POST')return json({error:'POST required'},405);
 try{
  const p=await req.json();
  if(!p.business_id)return json({error:'business_id required'},400);
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if(p.action==='list'){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(p.from_date||'')||!/^\d{4}-\d{2}-\d{2}$/.test(p.to_date||''))return json({error:'from_date and to_date required, YYYY-MM-DD'},400);
   const {data,error}=await db.from('calendar_items').select('id,title,due_date,due_time,notes,completed').eq('business_id',p.business_id).gte('due_date',p.from_date).lte('due_date',p.to_date).order('due_date').order('due_time').limit(500);
   if(error)return json({error:'Calendar read failed'},500);
   return json({items:data});
  }
  if(!p.item_id||typeof p.completed!=='boolean')return json({error:'item_id and completed boolean required'},400);
  const {data,error}=await db.from('calendar_items').update({completed:p.completed}).eq('business_id',p.business_id).eq('id',p.item_id).select('id,title,due_date,completed').single();
  if(error||!data){console.error('calendar completion',error);return json({error:'Calendar item not found for this business'},404);}
  return json({item:data});
 }catch{return json({error:'Invalid request'},400);}
});
