import { sourceRevision } from '../src/build-info.ts';
const webhook=process.env.WEBHOOK_URL,healthUrl=process.env.DEPLOY_HEALTH_URL;
if(!webhook||!healthUrl)throw new Error('Configure PORTAINER_WEBHOOK_URL and DEPLOY_HEALTH_URL before deploying.');
if(process.env.FORCE_REDEPLOY!=='true')try{
  const response=await fetch(healthUrl,{signal:AbortSignal.timeout(10000),cache:'no-store'}),health=await response.json();
  if(response.ok&&health.ok&&health.ready&&health.sourceRevision===sourceRevision){console.log('Expected revision is already healthy; no redeploy needed.');process.exit(0);}
}catch{}
// Deploy right away. A retry after a lost response can recreate a bot twice, so trigger
// once and let the following health step determine whether the deployment succeeded.
try{
  const response=await fetch(webhook,{method:'POST',signal:AbortSignal.timeout(60000)});
  console.log(response.ok?'Portainer deployment requested.':'Webhook returned HTTP '+response.status+'; checking whether the expected deployment started.');
}catch{console.log('Webhook response unavailable; checking the expected deployment.');}
