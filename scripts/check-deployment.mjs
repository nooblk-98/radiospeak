import { sourceRevision } from '../src/build-info.ts';

const address = process.env.DEPLOY_HEALTH_URL;
if (!address || !/^https?:\/\//.test(address)) throw new Error('Set DEPLOY_HEALTH_URL to the public /healthz URL.');
const until = Date.now() + Number(process.env.DEPLOY_TIMEOUT_MS || 180000);
let last = 'not reachable';
while (Date.now() < until) {
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    const health = await response.json();
    if (response.ok && health.ok && health.ready && health.sourceRevision === sourceRevision) {
      console.log('Expected source revision is healthy; all bot instances are connected.');
      process.exit(0);
    }
    last = `HTTP ${response.status}; ready=${!!health.ready}; expected revision=${health.sourceRevision === sourceRevision}`;
  } catch (error) { last = error.message; }
  await new Promise(resolve => setTimeout(resolve,5000));
}
throw new Error('Deployment did not become healthy: ' + last);
