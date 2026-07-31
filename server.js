const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { execFile } = require('node:child_process');

const port = Number(process.env.PORT || 5173);
const root = __dirname;
const realKubernetes = process.env.NORTHSTAR_MODE === 'kubernetes';
const kubectl = process.env.NORTHSTAR_KUBECTL || 'kubectl';
const kubeContext = process.env.NORTHSTAR_CONTEXT || 'kind-northstar';
const pods = [
  { name:'payments-api-7d88c96bbf-jk4m2', namespace:'platform', status:'Running', usage:'12m / 384Mi', restarts:0, age:'2d', node:'compute-02', image:'northstar/platform:v2.8.1', cpu:38, memory:62 },
  { name:'payments-api-7d88c96bbf-v9p8q', namespace:'platform', status:'Running', usage:'10m / 379Mi', restarts:0, age:'2d', node:'compute-03', image:'northstar/platform:v2.8.1', cpu:34, memory:59 },
  { name:'checkout-worker-5f6d4c7f79-q2r8x', namespace:'payments', status:'Running', usage:'28m / 512Mi', restarts:1, age:'6h', node:'compute-04', image:'northstar/payments:v2.8.1', cpu:51, memory:74 },
  { name:'checkout-worker-5f6d4c7f79-wn7c4', namespace:'payments', status:'Running', usage:'25m / 498Mi', restarts:0, age:'6h', node:'compute-01', image:'northstar/payments:v2.8.1', cpu:46, memory:68 },
  { name:'grafana-6c8b69b8cf-nm2kd', namespace:'observability', status:'Running', usage:'8m / 256Mi', restarts:0, age:'14d', node:'compute-02', image:'grafana/grafana:11.2', cpu:18, memory:43 },
  { name:'loki-0', namespace:'observability', status:'Running', usage:'42m / 1.2Gi', restarts:0, age:'14d', node:'compute-03', image:'grafana/loki:3.1', cpu:27, memory:61 },
  { name:'billing-sync-66c79d89d4-xk52l', namespace:'payments', status:'Pending', usage:'— / —', restarts:3, age:'4m', node:'—', image:'northstar/payments:v2.8.1', cpu:0, memory:0 },
  { name:'edge-router-7c97b68b89-pw1f7', namespace:'platform', status:'Running', usage:'16m / 197Mi', restarts:0, age:'21d', node:'compute-04', image:'northstar/platform:v2.8.1', cpu:29, memory:35 },
];
const logs = [
  'request completed method=GET path=/v1/orders duration=42ms', 'reconciled deployment replicas=3 ready=3',
  'cache hit key=customer:88421 ttl=240s', 'health check passed component=postgres',
  'request completed method=POST path=/v1/charge duration=118ms', 'connection pool active=12 idle=8',
  'received graceful shutdown signal'
];

function kubectlJson(args) {
  return new Promise((resolve, reject) => execFile(kubectl, ['--context', kubeContext, ...args], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(stderr || error.message));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('kubectl returned invalid JSON')); }
  }));
}
function realPods(items) {
  return items.map(p => ({
    name: p.metadata.name, namespace: p.metadata.namespace, status: p.status.phase,
    usage: '— / —', restarts: (p.status.containerStatuses || []).reduce((n, c) => n + c.restartCount, 0),
    age: p.metadata.creationTimestamp ? new Date(p.metadata.creationTimestamp).toLocaleDateString() : '—',
    node: p.spec.nodeName || '—', image: (p.spec.containers || []).map(c => c.image).join(', '), cpu: 0, memory: 0,
  }));
}
async function getRealPods() { return realPods((await kubectlJson(['get', 'pods', '-A', '-o', 'json'])).items); }

function send(res, status, body, type='application/json') { res.writeHead(status, {'Content-Type': `${type}; charset=utf-8`, 'Cache-Control':'no-store'}); res.end(type === 'application/json' ? JSON.stringify(body) : body); }
function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (realKubernetes && url.pathname === '/api/cluster') return getRealPods().then(list => send(res, 200, { name:kubeContext, mode:'kubernetes', health:list.every(p => p.status === 'Running') ? 100 : 92, runningPods:list.filter(p => p.status === 'Running').length, totalPods:list.length, cpu:0, alerts:list.filter(p => p.status !== 'Running').length })).catch(e => send(res, 503, {error:e.message}));
  if (realKubernetes && url.pathname === '/api/pods') return getRealPods().then(list => { const ns=url.searchParams.get('namespace'), q=(url.searchParams.get('q')||'').toLowerCase(); return send(res, 200, list.filter(p => (!ns || ns === 'all' || p.namespace === ns) && (!q || JSON.stringify(p).toLowerCase().includes(q)))); }).catch(e => send(res, 503, {error:e.message}));
  if (realKubernetes && url.pathname.match(/^\/api\/pods\/([^/]+)\/logs$/)) { const name=decodeURIComponent(url.pathname.split('/')[3]); return new Promise(resolve => execFile(kubectl, ['--context',kubeContext,'logs',`pod/${name}`,'--all-containers=true','--tail=50'], {maxBuffer:1024*1024}, (error, stdout) => { const lines=(stdout||'').trim().split('\n').filter(Boolean).map((message,i)=>({time:`live ${i+1}`,level:'INFO',message})); send(res, error ? 404 : 200, error ? {error:'Unable to read pod logs'} : lines); resolve(); })); }
  if (realKubernetes && url.pathname.match(/^\/api\/pods\/([^/]+)$/)) { const name=decodeURIComponent(url.pathname.split('/')[3]); return getRealPods().then(list => { const pod=list.find(p=>p.name===name); return send(res, pod ? 200 : 404, pod || {error:'Pod not found'}); }).catch(e=>send(res,503,{error:e.message})); }
  if (url.pathname === '/api/cluster') return send(res, 200, { name:'production-east', mode:'simulated', health:98.7, runningPods:87, totalPods:94, cpu:42.8, alerts:3 });
  if (url.pathname === '/api/pods') {
    const ns = url.searchParams.get('namespace');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    return send(res, 200, pods.filter(p => (!ns || ns === 'all' || p.namespace === ns) && (!q || JSON.stringify(p).toLowerCase().includes(q))));
  }
  const podMatch = url.pathname.match(/^\/api\/pods\/([^/]+)\/([^/]+)$/);
  if (podMatch && podMatch[2] === 'logs') {
    const pod = pods.find(p => p.name === decodeURIComponent(podMatch[1]));
    return send(res, pod ? 200 : 404, pod ? logs.map((message, i) => ({time:`11:${25+i}`, level:i === 4 ? 'WARN' : 'INFO', message})) : {error:'Pod not found'});
  }
  const detailMatch = url.pathname.match(/^\/api\/pods\/([^/]+)$/);
  if (detailMatch) { const pod = pods.find(p => p.name === decodeURIComponent(detailMatch[1])); return send(res, pod ? 200 : 404, pod || {error:'Pod not found'}); }
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(root, 'index.html')), 'text/html');
  return send(res, 404, {error:'Not found'});
}
http.createServer(route).listen(port, () => console.log(`Northstar running at http://localhost:${port} (simulated cluster)`));
