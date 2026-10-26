import { sourceRevision } from '../src/build-info.ts';
import { appendFileSync } from 'node:fs';
const webhook=process.env.WEBHOOK_URL,healthUrl=process.env.DEPLOY_HEALTH_URL;
if(!webhook||!healthUrl)throw new Error('Configure PORTAINER_WEBHOOK_URL and DEPLOY_HEALTH_URL before deploying.');
let alreadyHealthy=false;
if(process.env.FORCE_REDEPLOY!=='true')try{
  const response=await fetch(healthUrl,{signal:AbortSignal.timeout(10000),cache:'no-store'}),health=await response.json();
  if(response.ok&&health.ok&&health.ready&&health.sourceRevision===sourceRevision){console.log('Expected revision is already healthy; no redeploy needed.');alreadyHealthy=true;}
}catch{}
if(!alreadyHealthy && process.env.RADIOSPEAK_DEPLOY_TOKEN){
  const endpoint=new URL('/api/deployments',healthUrl);
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.RADIOSPEAK_DEPLOY_TOKEN},body:JSON.stringify({revision:sourceRevision,webhook,force:process.env.FORCE_REDEPLOY==='true'}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Deployment coordinator returned HTTP '+response.status+'; no direct redeploy was attempted.');
  const data=await response.json();
  const deferred=data.policy?.mode==='window'&&process.env.FORCE_REDEPLOY!=='true';
  const timeout=(data.policy?.mode==='track-end'&&process.env.FORCE_REDEPLOY!=='true'?(data.policy.maxWaitMinutes||30)*60:0)+180;
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'deferred='+deferred+'\ntimeout_seconds='+timeout+'\n');
  console.log('Deployment queued: '+(data.deployment?.message||'Waiting for deployment policy')+(deferred?'. Check the notification bell for completion.':'. The health check will verify the expected source after current songs finish.'));
} else if(!alreadyHealthy) {
// A retry after a lost response can recreate a bot twice. Trigger once, then let
// the following health step determine whether the requested deployment succeeded.
try{
  const response=await fetch(webhook,{method:'POST',signal:AbortSignal.timeout(60000)});
  console.log(response.ok?'Portainer deployment requested.':'Webhook returned HTTP '+response.status+'; checking whether the expected deployment started.');
}catch{console.log('Webhook response unavailable; checking the expected deployment.');}
}
