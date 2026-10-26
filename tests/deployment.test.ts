import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sourceRevision } from "../src/build-info.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("deployment checks skip a healthy revision and a lost webhook response never causes a duplicate trigger",async()=>{
  let ready=true,triggers=0;
  const server=createServer((req,res)=>{
    if(req.url==='/webhook') { triggers++;ready=true;res.destroy();return; }
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,ready,sourceRevision}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base='http://127.0.0.1:'+address.port;
  const run=(script:string)=>promisify(execFile)(process.execPath,[script],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{...process.env,DEPLOY_HEALTH_URL:base+'/healthz',WEBHOOK_URL:base+'/webhook',FORCE_REDEPLOY:'false'},windowsHide:true,
  });
  try{
    assert.match((await run('scripts/deploy.mjs')).stdout,/already healthy/);assert.equal(triggers,0);
    ready=false;await run('scripts/deploy.mjs');assert.equal(triggers,1);
    assert.match((await run('scripts/check-deployment.mjs')).stdout,/Expected source revision is healthy/);
    await run('scripts/deploy.mjs');assert.equal(triggers,1);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("CI sends authenticated coordinator requests and reports deferred windows without triggering the webhook directly",async()=>{
  let requests=0,direct=0,window=true;
  const server=createServer(async(req,res)=>{
    if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,ready:true,sourceRevision:'old'}));return;}
    if(req.url==='/api/deployments') {
      requests++;assert.equal(req.headers.authorization,'Bearer test-deployment-token');let body='';for await(const chunk of req)body+=chunk;
      const payload=JSON.parse(body);assert.equal(payload.revision,sourceRevision);assert.match(payload.webhook,/\/webhook$/);
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({policy:{mode:window?'window':'track-end',maxWaitMinutes:12},deployment:{message:'Waiting for policy'}}));return;
    }
    direct++;res.end();
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port,dir=mkdtempSync(join(tmpdir(),'radiospeak-deploy-'));
  try {
    const output=join(dir,'outputs');const run=()=>promisify(execFile)(process.execPath,['scripts/deploy.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,DEPLOY_HEALTH_URL:base+'/healthz',WEBHOOK_URL:base+'/webhook',RADIOSPEAK_DEPLOY_TOKEN:'test-deployment-token',GITHUB_OUTPUT:output,FORCE_REDEPLOY:'false'},windowsHide:true});
    assert.match((await run()).stdout,/queued/);assert.match(readFileSync(output,'utf8'),/deferred=true/);assert.equal(requests,1);assert.equal(direct,0);
    window=false;await run();assert.match(readFileSync(output,'utf8'),/deferred=false\ntimeout_seconds=900/);assert.equal(direct,0);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
