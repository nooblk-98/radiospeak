import { loadConfig } from "../src/config/config.ts";
try {
  const { web } = loadConfig();
  if (!web.enabled) process.exit(0);
  const host = ["0.0.0.0", "::"].includes(web.host) ? "127.0.0.1" : web.host;
  const health = await (
    await fetch(`http://${host.includes(":") ? "[" + host + "]" : host}:${web.port}/healthz`, {
      signal: AbortSignal.timeout(4000),
    })
  ).json();
  process.exit(health.ok ? 0 : 1);
} catch {
  process.exit(1);
}
