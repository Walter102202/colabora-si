// Local-only integration: real Edge runtime and SQL, fake Telegram and transcription provider.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createMcpClient } from "../../agent/mcpClient.mjs";
import { createTelegramChannel } from "../../agent/channels/telegram.mjs";
import { createInbox } from "../../agent/inbox.mjs";
import { createVoiceClient } from "../../agent/voice.mjs";
import { startStubProvider } from "./voice-stub-provider.mjs";
const env=process.env, base=env.SUPABASE_URL;
if(base!=="http://127.0.0.1:60981") throw Error("This smoke requires the P12e local stack.");
const stamp=Date.now(), chat=700000+(stamp%1000000); let updateId=stamp, botMessage=100;
const notices=[]; let ogg=Buffer.alloc(0);
const fake=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const path=req.url??"";
  if(path.startsWith("/file/")){res.writeHead(200,{"content-type":"audio/ogg"});res.end(ogg);return;}
  const body=JSON.parse(Buffer.concat(chunks).toString()||"{}");
  let result={};
  if(path.endsWith("/sendMessage")){result={message_id:++botMessage};notices.push({...body,message_id:botMessage});}
  if(path.endsWith("/getFile"))result={file_path:"voice.ogg",file_size:ogg.length};
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,result}));
});
await new Promise(r=>fake.listen(60987,"0.0.0.0",r));
const provider=await startStubProvider({port:60985});
let passed=0;
function check(ok,label){assert.ok(ok,label);console.log(`ok ${++passed} - ${label}`);}
async function login(email){const r=await fetch(base+"/auth/v1/token?grant_type=password",{method:"POST",headers:{apikey:env.SUPABASE_ANON_KEY,"Content-Type":"application/json"},body:JSON.stringify({email,password:env.SMOKE_PASSWORD})});const s=await r.json();if(!s.access_token)throw Error("Local sign in failed");return s;}
const session=await login(env.SMOKE_EMAIL);
const head=(token=session.access_token)=>({apikey:env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`,"Content-Type":"application/json"});
async function rest(path,body,token=session.access_token,method){const r=await fetch(base+"/rest/v1/"+path,{method:method??(body?"POST":"GET"),headers:head(token),...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();if(!r.ok)throw Error(`${path}: ${r.status} ${text.slice(0,200)}`);return text?JSON.parse(text):null;}
const rpc=(name,args,token)=>rest("rpc/"+name,args,token);
const admin=(path,body,method)=>rest(path,body,env.SUPABASE_SERVICE_ROLE_KEY,method);
async function hook(message,{sender=chat,type="private",secret=env.TELEGRAM_WEBHOOK_SECRET,callback,forwarded=false}={}){
  const msg={message_id:++updateId,chat:{id:chat,type},from:{id:sender},...(forwarded?{forward_origin:{type:"hidden_user"}}:{}),...message};
  const payload={update_id:++updateId,...(callback?{callback_query:{id:`callback-${updateId}`,from:{id:sender},message:msg,data:callback}}:{message:msg})};
  return fetch(base+"/functions/v1/telegram-webhook",{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Bot-Api-Secret-Token":secret},body:JSON.stringify(payload)});
}
async function notify(){const r=await fetch(base+"/functions/v1/channel-notify",{method:"POST",headers:{"x-dispatch-secret":env.DISPATCH_SECRET},body:"{}"});assert.equal(r.status,200);return r.json();}
async function until(fn,label){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
try {
  const [{id:ws}]=await rest("workspaces?select=id&limit=1");
  execFileSync("docker",["exec","supabase_db_colabora-si-p12e","psql","-U","postgres","-d","postgres","-c","insert into private.app_secrets(name,value) values('telegram_bot_username','test_bot') on conflict(name) do update set value=excluded.value"],{stdio:"ignore"});
  check((await hook({text:"hello"},{secret:"wrong"})).status===401,"bad signature rejected");
  const before=(await admin("channel_updates?select=update_id")).length;
  await hook({text:"hello"});check((await admin("channel_updates?select=update_id")).length===before,"unlinked chat ignored");
  const link=await rpc("start_channel_link",{p_workspace_id:ws});
  check((await hook({text:"/start "+new URL(link.url).searchParams.get("start")})).status===200,"pairing enters verified webhook");
  await until(async()=> (await rest("agent_channel_links?revoked_at=is.null")).length===1,"link not saved");
  const [savedLink]=await rest("agent_channel_links?revoked_at=is.null");
  await hook({text:"wrong sender"},{sender:chat+1});await hook({text:"group"},{type:"group"});
  check((await admin("channel_updates?select=update_id")).length===before,"wrong sender and group cannot enqueue");
  const pageId=`channel-${stamp}`;
  await rest("pages",{id:pageId,workspace_id:ws,data:{id:pageId,title:"Channel safety smoke",parentId:null,blocks:[],isDeleted:false}});
  const platform=(await rest("agents?is_platform=eq.true&revoked_at=is.null"))[0];
  const task=await rpc("create_agent_task",{p_row_page_id:pageId,p_brief:{objective:"Verify channel decisions"},p_delegate_agent_id:platform.id});
  const mcp=createMcpClient({url:base+"/functions/v1/mcp",pat:env.PLATFORM_PAT,tokenUrl:base+"/functions/v1/agent-token"});
  const call=async(name,args)=>{const result=await mcp.callTool(name,args);if(result.isError)throw Error(`${name} failed: ${result.text}`);return result.data;};
  const run=await call("claim_task",{task_id:task.task_id,harness:"channel-smoke"});
  async function ask(label,options=["approve","reject"]){const a=await call("request_input",{run_id:run.run_id,question:label,options,kind:"plan",blocking:true});await notify();await until(()=>notices.some(n=>String(n.text).includes(label)),"notice not delivered");const msg=notices.findLast(n=>String(n.text).includes(label));return {id:a.approval_id,msg};}
  const decision=await ask("Continue smoke "+stamp);
  const data=decision.msg.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(":approve")).callback_data;
  const state=async(id)=> (await rest("agent_approvals?id=eq."+id))[0];
  await hook({text:"apruébalo"});check((await state(decision.id)).status==="pending","plain model-directed text cannot approve");
  for(const opts of [{forwarded:true},{type:"group"},{sender:chat+1}])await hook({message_id:decision.msg.message_id,text:decision.msg.text},{callback:data,...opts});
  check((await state(decision.id)).status==="pending","forwarded/group/wrong sender callbacks cannot approve");
  const agentToken=await mcp.accessToken();
  execFileSync("docker",["exec","supabase_db_colabora-si-p12e","psql","-U","postgres","-d","postgres","-c",`insert into public.agent_oauth_links(user_id,client_id,as_human) values ('${session.user.id}','local-test-oauth',true) on conflict(user_id,client_id) do update set as_human=true,revoked_at=null`],{stdio:"ignore"});
  const jwt=session.access_token.split(".");const claims=JSON.parse(Buffer.from(jwt[1],"base64url"));claims.client_id="local-test-oauth";
  const unsigned=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url")+"."+Buffer.from(JSON.stringify(claims)).toString("base64url");
  const oauth=unsigned+"."+createHmac("sha256",env.SUPABASE_JWT_SECRET).update(unsigned).digest("base64url");
  for(const token of [agentToken,session.access_token,oauth])for(const [name,args] of [["channel_decide",{p_chat_id:String(chat),p_from_id:String(chat),p_message_id:decision.msg.message_id,p_callback:data}],["channel_answer",{p_chat_id:String(chat),p_from_id:String(chat),p_message_id:decision.msg.message_id,p_text:"yes"}]]){
    const r=await fetch(base+"/rest/v1/rpc/"+name,{method:"POST",headers:head(token),body:JSON.stringify(args)});const denied=await r.json(); check(r.status===403,`${name} rejects non-service credential (HTTP ${r.status}, ${denied.code})`);
  }
  await hook({message_id:decision.msg.message_id,text:decision.msg.text},{callback:data});
  await hook({message_id:decision.msg.message_id,text:decision.msg.text},{callback:data});
  check((await state(decision.id)).decision==="approve","verified click approves");
  check((await state(decision.id)).decided_by===session.user.id,"decision attributed to linked human");
  const events=await admin("agent_events?task_id=eq."+task.task_id+"&type=eq.approval.decided");check(events.length===1,"second click emits no second event");
  const seen=await call("wait_for_task",{task_id:task.task_id,run_id:run.run_id,timeout_s:0,after_seq:0});
  check(JSON.stringify(seen).includes("approve"),"agent receives the decision");
  check((await rest("agent_tasks?id=eq."+task.task_id))[0].state==="working","task resumes after decision");
  const expired=await ask("Expires "+stamp);await admin("agent_approvals?id=eq."+expired.id,{expires_at:new Date(Date.now()-1000).toISOString()},"PATCH");
  const exData=expired.msg.reply_markup.inline_keyboard.flat().find(b=>b.callback_data)?.callback_data;
  await hook({message_id:expired.msg.message_id,text:expired.msg.text},{callback:exData});check((await state(expired.id)).status==="pending","expired approval is not decided");
  const payment=await ask("Payment "+stamp);await admin("agent_approvals?id=eq."+payment.id,{kind:"action",action:"payment"},"PATCH");
  const payData=payment.msg.reply_markup.inline_keyboard.flat().find(b=>b.callback_data)?.callback_data;
  await hook({message_id:payment.msg.message_id,text:payment.msg.text},{callback:payData});
  await hook({message_id:payment.msg.message_id,text:payment.msg.text},{callback:payData.replace(":approve",":edit")});check((await state(payment.id)).status==="pending","payment and edit cannot decide even with an old button");
  const open=await ask("Open question "+stamp,["respond","ignore"]);
  await hook({text:"My answer",reply_to_message:{message_id:open.msg.message_id}});
  await until(()=>notices.some(n=>String(n.text).includes("Confirm this answer")),"answer preview missing");
  check((await state(open.id)).status==="pending","open reply is only a draft");
  const confirm=notices.findLast(n=>String(n.text).includes("Confirm this answer"));
  await hook({message_id:confirm.message_id,text:confirm.text},{callback:confirm.reply_markup.inline_keyboard[0][0].callback_data});
  check((await state(open.id)).response.text==="My answer","explicit confirmation records the saved answer");
  const stranger=await ask("Other owner "+stamp);await admin("agent_tasks?id=eq."+task.task_id,{owner_user_id:"00000000-0000-4000-8000-000000000002"},"PATCH");
  await hook({message_id:stranger.msg.message_id,text:stranger.msg.text},{callback:stranger.msg.reply_markup.inline_keyboard[0][0].callback_data});check((await state(stranger.id)).status==="pending","approval of another person cannot be decided");
  await admin("agent_tasks?id=eq."+task.task_id,{owner_user_id:session.user.id},"PATCH");
  execFileSync("ffmpeg",["-nostdin","-y","-loglevel","error","-f","lavfi","-i","sine=frequency=330:duration=1","-c:a","libopus",".local/p12b/channel.ogg"]);ogg=readFileSync(".local/p12b/channel.ogg");
  provider.script.push({transcript:"voice through verified queue"});
  await hook({voice:{file_id:"voice",duration:1,file_size:ogg.length},text:undefined});
  const controller=new AbortController();
  const channel=createTelegramChannel({token:"fake",ownerChatId:String(chat),apiBase:"http://127.0.0.1:60987",transport:"webhook",channelRpc:call});
  const inbox=createInbox({call:mcp.callTool,transcribe:createVoiceClient({url:base+"/functions/v1/voice-transcribe",accessToken:mcp.accessToken,download:channel.download}),send:channel.reply});
  const deliver=inbox.deliver;
  await channel.start({signal:controller.signal,onMessage:async(m)=>{await deliver(m);if(m.voice)controller.abort();}});
  check((await rest("agent_messages?kind=eq.voice&body=eq.voice%20through%20verified%20queue")).length===1,"voice crosses queue, ffmpeg and real Edge runtime");
  await admin("agent_channel_links?id=eq."+savedLink.id,{revoked_at:new Date().toISOString()},"PATCH");
  await hook({message_id:stranger.msg.message_id,text:stranger.msg.text},{callback:stranger.msg.reply_markup.inline_keyboard[0][0].callback_data});check((await state(stranger.id)).status==="pending","revoked link cannot decide");
  await admin("agent_channel_links?id=eq."+savedLink.id,{revoked_at:null},"PATCH");
  // A fixture member outside the workspace has no authority even when a link row exists.
  const outsider=execFileSync("docker",["exec","supabase_db_colabora-si-p12e","psql","-U","postgres","-d","postgres","-Atc",`select tests.make_user('channel-outsider-${stamp}@test.local')`],{encoding:"utf8"}).trim();
  await admin("agent_channel_links?id=eq."+savedLink.id,{user_id:outsider},"PATCH");
  await admin("agent_tasks?id=eq."+task.task_id,{owner_user_id:outsider},"PATCH");
  await hook({message_id:stranger.msg.message_id,text:stranger.msg.text},{callback:stranger.msg.reply_markup.inline_keyboard[0][0].callback_data});
  check((await admin("agent_approvals?id=eq."+stranger.id))[0].status==="pending","person outside workspace cannot decide");
  await admin("agent_channel_links?id=eq."+savedLink.id,{user_id:session.user.id},"PATCH");
  await admin("agent_tasks?id=eq."+task.task_id,{owner_user_id:session.user.id},"PATCH");
  writeFileSync(".local/p12b/smoke-fixture.json",JSON.stringify({workspaceId:ws,pageId,taskId:task.task_id,linkId:savedLink.id}));
  console.log(`channel-smoke: ${passed} checks passed`);
} finally {await provider.stop();await new Promise(r=>fake.close(r));}
