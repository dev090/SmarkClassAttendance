#!/usr/bin/env node
/**
 * Starts a Cloudflare quick tunnel to the local backend, waits for the public URL, writes it into the
 * phone app's default (mobile/lib/core/app_config.dart) and keeps the tunnel running in the foreground.
 * Quick tunnels get a new random address every start and die when the laptop changes network — just rerun.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.TUNNEL_TARGET ?? 'http://localhost:4000';
const appConfig = path.join(root, 'mobile/lib/core/app_config.dart');

const child = spawn('cloudflared', ['tunnel', '--url', target, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;

const onData = (chunk) => {
  const text = chunk.toString();
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !announced) {
    announced = true;
    const url = m[0];
    try {
      const src = readFileSync(appConfig, 'utf8');
      writeFileSync(appConfig, src.replace(/defaultValue: 'https:\/\/[a-z0-9-]+\.trycloudflare\.com'/, `defaultValue: '${url}'`));
    } catch {}
    console.log('\n==========================================================');
    console.log(`  Public backend URL:  ${url}`);
    console.log('  → Server URL in the phone app (also written as the app default).');
    console.log('  Keep this window open. Rerun after a network change.');
    console.log('==========================================================\n');
  }
  if (/ERR|Tunnel not found|Registered tunnel connection/.test(text)) process.stdout.write(text);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) => {
  console.log(`cloudflared exited (${code}). Rerun: pnpm tunnel`);
  process.exit(code ?? 1);
});
process.on('SIGINT', () => child.kill('SIGINT'));
