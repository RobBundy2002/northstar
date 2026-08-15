const { spawn } = require('node:child_process');
const { createConnection } = require('node:net');
const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const kubectl = process.env.NORTHSTAR_KUBECTL || '/tmp/northstar-kubectl';
const prometheusName = `northstar-prometheus-${process.pid}`;
const configPath = path.join('/tmp', `northstar-prometheus-${process.pid}.yml`);
const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(child);
  child.on('exit', code => {
    if (code && !shuttingDown) shutdown(code);
  });
  return child;
}

let shuttingDown = false;
function portIsFree(port) {
  return new Promise(resolve => {
    const probe = createConnection({ host: '127.0.0.1', port });
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(true));
  });
}
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  const cleanup = spawn('docker', ['rm', '-f', prometheusName], { stdio: 'ignore' });
  cleanup.on('exit', () => { try { unlinkSync(configPath); } catch {} process.exit(code); });
  setTimeout(() => process.exit(code), 5000).unref();
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

(async () => {
  const requestedPort = Number(process.env.PORT || 5173);
  let appPort = requestedPort;
  while (!(await portIsFree(appPort))) appPort += 1;
  const requestedPromPort = Number(process.env.PROMETHEUS_PORT || 9090);
  let promPort = requestedPromPort;
  while (!(await portIsFree(promPort))) promPort += 1;
  const baseConfig = readFileSync(path.join(__dirname, 'prometheus.yml'), 'utf8');
  writeFileSync(configPath, baseConfig.replaceAll(':5173', `:${appPort}`));

  start(process.execPath, [path.join(__dirname, 'server.js')], {
    PORT: String(appPort),
    NORTHSTAR_MODE: 'kubernetes',
    NORTHSTAR_CONTEXT: 'production-east',
    NORTHSTAR_KUBECTL: kubectl,
    NORTHSTAR_PROMETHEUS_URL: `http://localhost:${promPort}`,
  });
  setTimeout(() => start('docker', [
    'run', '--rm', '--name', prometheusName,
    '--add-host=host.docker.internal:host-gateway',
    '-p', `${promPort}:9090`,
    '-v', `${configPath}:/etc/prometheus/prometheus.yml:ro`,
    'prom/prometheus',
  ]), 1200);
  console.log(`Northstar + Prometheus starting. Open http://localhost:${appPort}`);
  if (appPort !== requestedPort) console.log(`Port ${requestedPort} was busy; Northstar is using ${appPort}.`);
  if (promPort !== requestedPromPort) console.log(`Prometheus port ${requestedPromPort} was busy; Prometheus is using ${promPort}.`);
})();
