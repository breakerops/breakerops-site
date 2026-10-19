import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const json=(body:unknown,status=200)=>Response.json(body,{status});
Deno.serve(async(req)=>{
 const key=Deno.env.get('REMINDERS_KEY');
 if(!key||req.headers.get('x-reminders-key')!==key)return json({error:'unauthorized'},401);
 if(req.method!=='POST')return json({error:'POST required'},405);
 try{
  const p=await req.json();
  if(!p.business_id||!p.item_id||typeof p.completed!=='boolean')return json({error:'business_id, item_id and completed boolean required'},400);
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const {data,error}=await db.from('calendar_items').update({completed:p.completed}).eq('business_id',p.business_id).eq('id',p.item_id).select('id,title,due_date,completed').single();
  if(error||!data)return json({error:'Calendar item not found for this business'},404);
  return json({item:data});
 }catch{return json({error:'Invalid request'},400);}
});
