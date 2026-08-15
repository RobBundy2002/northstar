const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { execFile, spawn } = require('node:child_process');
const { validResourcePart, validApiResource, validExecCommand } = require('./lib/validation');

const port = Number(process.env.PORT || 5173);
const root = __dirname;
const kubectl = process.env.NORTHSTAR_KUBECTL || 'kubectl';
const defaultContext = process.env.NORTHSTAR_CONTEXT || 'production-east';
const prometheusUrl = process.env.NORTHSTAR_PROMETHEUS_URL || '';
const kubeconfig = process.env.NORTHSTAR_KUBECONFIG || process.env.KUBECONFIG || '';
const dataDir = process.env.NORTHSTAR_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dashboardFile = path.join(dataDir, 'dashboards.json');
const auditFile = path.join(dataDir, 'audit.jsonl');
const readOnly = /^(1|true|yes|on)$/i.test(process.env.NORTHSTAR_READ_ONLY || '');
const portForwards = new Map();

const simulatedContexts = [
  { name: 'production-east', cluster: 'prod-east', environment: 'Production', color: '#63d5d4' },
  { name: 'staging-west', cluster: 'stage-west', environment: 'Staging', color: '#e5ad65' },
  { name: 'dev-sandbox', cluster: 'dev-sandbox', environment: 'Development', color: '#a79cff' },
];
const simulated = {
  'production-east': { pods: 8, healthy: 7, namespaces: ['platform', 'payments', 'observability'], workloads: [['Deployment','payments-api','platform',2,2],['Deployment','checkout-worker','payments',2,2],['Deployment','StatefulSet','loki','observability',1,1]], nodes: 3 },
  'staging-west': { pods: 5, healthy: 4, namespaces: ['northstar', 'preview', 'observability'], workloads: [['Deployment','payments-api','northstar',3,3],['Deployment','checkout-worker','northstar',1,1],['Deployment','release-candidate','preview',2,1]], nodes: 2 },
  'dev-sandbox': { pods: 4, healthy: 3, namespaces: ['northstar', 'feature-flags'], workloads: [['Deployment','payments-api','northstar',1,1],['Deployment','checkout-worker','northstar',1,1],['Deployment','feature-preview','feature-flags',2,1]], nodes: 1 },
};
const fakePods = [
  ['payments-api-7d88c96bbf-jk4m2','platform','Running','12m / 384Mi',0,'2d','compute-02','northstar/platform:v2.8.1',38,62], ['payments-api-7d88c96bbf-v9p8q','platform','Running','10m / 379Mi',0,'2d','compute-03','northstar/platform:v2.8.1',34,59], ['checkout-worker-5f6d4c7f79-q2r8x','payments','Running','28m / 512Mi',1,'6h','compute-04','northstar/payments:v2.8.1',51,74], ['checkout-worker-5f6d4c7f79-wn7c4','payments','Running','25m / 498Mi',0,'6h','compute-01','northstar/payments:v2.8.1',46,68], ['grafana-6c8b69b8cf-nm2kd','observability','Running','8m / 256Mi',0,'14d','compute-02','grafana/grafana:11.2',18,43], ['loki-0','observability','Running','42m / 1.2Gi',0,'14d','compute-03','grafana/loki:3.1',27,61], ['billing-sync-66c79d89d4-xk52l','payments','Pending','— / —',3,'4m','—','northstar/payments:v2.8.1',0,0], ['edge-router-7c97b68b89-pw1f7','platform','Running','16m / 197Mi',0,'21d','compute-04','northstar/platform:v2.8.1',29,35],
];
const fakeLogs = ['request completed method=GET path=/v1/orders duration=42ms','reconciled deployment replicas=3 ready=3','cache hit key=customer:88421 ttl=240s','health check passed component=postgres','request completed method=POST path=/v1/charge duration=118ms','connection pool active=12 idle=8'];

function execKubectl(context, args, options = {}) {
  const env = { ...process.env, ...(kubeconfig ? { KUBECONFIG:kubeconfig } : {}) };
  return new Promise((resolve, reject) => execFile(kubectl, ['--context', context, ...args], { maxBuffer: 16 * 1024 * 1024, env, ...options }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}
async function json(context, args) { return JSON.parse(await execKubectl(context, args)); }
function kubectlEnv() { return { ...process.env, ...(kubeconfig ? { KUBECONFIG:kubeconfig } : {}) }; }
function send(res, status, body, type = 'application/json') { res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); }
function body(req) { return new Promise(resolve => { let data = ''; req.on('data', x => data += x); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } }); }); }
function age(date) { if (!date) return '—'; const mins = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 60000)); return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`; }
function normalizePod(p) { const owner=(p.metadata.ownerReferences||[])[0]; return { name:p.metadata.name, namespace:p.metadata.namespace, status:p.status.phase || 'Unknown', usage:'— / —', restarts:(p.status.containerStatuses || []).reduce((n,c) => n + c.restartCount, 0), age:age(p.metadata.creationTimestamp), node:p.spec.nodeName || '—', image:(p.spec.containers || []).map(c => c.image).join(', '), cpu:0, memory:0, containers:(p.spec.containers || []).map(c => c.name), ownerKind:owner?.kind?.toLowerCase() || '', ownerName:owner?.name || '' }; }
function filterItems(items, url) { const ns = url.searchParams.get('namespace'), q = (url.searchParams.get('q') || '').toLowerCase(); return items.filter(x => (!ns || ns === 'all' || x.namespace === ns) && (!q || JSON.stringify(x).toLowerCase().includes(q))); }
function requireResource(a) { if (!validResourcePart(a.namespace) || !validResourcePart(a.name)) throw new Error('Invalid namespace or resource name'); }
function requestActor(req) { return req.headers['x-northstar-actor'] || req.headers['x-forwarded-user'] || 'local-operator'; }
function audit(req, event) { fs.appendFileSync(auditFile, `${JSON.stringify({ timestamp:new Date().toISOString(), actor:requestActor(req), ...event })}\n`); }
function productionContext(context) { return /(^|[-_])(prod|production)([-_]|$)/i.test(context) || /production/i.test(context); }
function confirmed(req, data = {}) { return data.confirmProduction === true || /^(1|true|yes)$/i.test(String(req.headers['x-northstar-confirm-production'] || '')); }
function mutationGuard(req, res, details, data = {}) {
  const base = { action:details.action, context:details.context, namespace:details.namespace, resource:details.resource, outcome:'denied' };
  if (readOnly) { audit(req, { ...base, reason:'read-only' }); send(res, 403, { error:'Northstar is running in read-only mode. Set NORTHSTAR_READ_ONLY=false to enable cluster actions.', readOnly:true }); return true; }
  if (productionContext(details.context) && !confirmed(req, data)) { audit(req, { ...base, reason:'production-confirmation-required' }); send(res, 409, { error:'Production actions require confirmProduction=true or X-Northstar-Confirm-Production: true.', productionGuard:true }); return true; }
  if (details.action === 'scale' && Number(data.replicas) === 0 && !confirmed(req, data)) { audit(req, { ...base, reason:'scale-to-zero-confirmation-required' }); send(res, 409, { error:'Scaling to zero requires explicit confirmation.', productionGuard:true }); return true; }
  return false;
}
async function authorizeKubernetesAction(context, data) {
  if (process.env.NORTHSTAR_MODE !== 'kubernetes') return true;
  const kind = String(data.kind || 'deployment').toLowerCase();
  const map = {
    delete:['delete', kind === 'pod' ? 'pods' : `${kind}s`],
    'rollout-restart':['update', `${kind}s`],
    scale:['update', `${kind}s`],
    resources:['update', `${kind}s`],
    exec:['create', 'pods/exec'],
    'port-forward':['create', 'pods/portforward'],
  };
  const [verb, resource] = map[data.action] || [];
  if (!verb) return true;
  const result = await execKubectl(context, ['auth','can-i',verb,resource,'-n',data.namespace]);
  return /^yes\s*$/i.test(result.trim());
}
function rejectReadOnly(res) { return send(res, 403, { error:'Northstar is running in read-only mode. Set NORTHSTAR_READ_ONLY=false to enable cluster actions.', readOnly:true }); }
function summarizeResource(item) {
  const containers = item.spec?.template?.spec?.containers || item.spec?.containers || [];
  return {
    kind:item.kind,
    name:item.metadata?.name,
    namespace:item.metadata?.namespace || '',
    status:item.status?.phase || item.status?.conditions?.find(x=>x.type==='Ready')?.status || item.status?.readyReplicas || item.status?.succeeded || '',
    age:age(item.metadata?.creationTimestamp),
    images:containers.map(c=>c.image).filter(Boolean).join(', '),
    labels:item.metadata?.labels || {},
  };
}
async function resourceCatalog(context) {
  const out = await execKubectl(context, ['api-resources', '--verbs=list']);
  const lines = out.trim().split('\n').slice(1).filter(Boolean);
  return lines.map(line => {
    const parts = line.trim().split(/\s{2,}/);
    const hasShortNames = parts.length >= 5;
    return { name:parts[0], shortNames:hasShortNames ? parts[1] : '', apiGroup:hasShortNames ? parts[2] : parts[1] || '', namespaced:(hasShortNames ? parts[3] : parts[2]) === 'true', kind:hasShortNames ? parts[4] : parts[3] || '' };
  }).filter(x => x.name);
}
async function clusterSummary(context) {
  let ps,m,version;
  if (process.env.NORTHSTAR_MODE === 'kubernetes') {
    [m,version]=await Promise.all([k8sMetrics(context),k8sVersion(context)]);
    ps=applyMetrics(await k8sPods(context),m);
  } else {
    ps=fakePodObjects(context);m={available:true,clusterCpu:42.8,clusterMemory:61.8};version='simulated';
  }
  return { name:context, mode:process.env.NORTHSTAR_MODE === 'kubernetes' ? 'kubernetes' : 'simulated', version, health:ps.length ? Math.round(ps.filter(p=>p.status==='Running').length / ps.length * 1000) / 10 : 0, runningPods:ps.filter(p=>p.status==='Running').length, totalPods:ps.length, cpu:m.available ? m.clusterCpu : null, memory:m.available ? m.clusterMemory : null, alerts:ps.filter(p=>p.status!=='Running').length, metricsAvailable:m.available };
}
async function queryPrometheus(query) { if (!prometheusUrl) return { configured:false, query, data:null }; const target = `${prometheusUrl.replace(/\/$/,'')}/api/v1/query?${new URLSearchParams({query})}`; const result = await fetch(target); if (!result.ok) throw new Error(`Prometheus returned ${result.status}`); return { configured:true, query, data:await result.json() }; }
async function metricsText(context) { let ps,m; if (process.env.NORTHSTAR_MODE === 'kubernetes') { m=await k8sMetrics(context); ps=applyMetrics(await k8sPods(context),m); } else { ps=fakePodObjects(context);m={clusterCpu:42.8,clusterMemory:61.8}; } const lines=['# HELP northstar_cluster_cpu_percent Average node CPU utilization.','# TYPE northstar_cluster_cpu_percent gauge',`northstar_cluster_cpu_percent{context="${context}"} ${m.clusterCpu ?? 0}`,'# HELP northstar_cluster_memory_percent Average node memory utilization.','# TYPE northstar_cluster_memory_percent gauge',`northstar_cluster_memory_percent{context="${context}"} ${m.clusterMemory ?? 0}`,'# HELP northstar_pods_total Total pods visible to Northstar.','# TYPE northstar_pods_total gauge',`northstar_pods_total{context="${context}"} ${ps.length}`,'# HELP northstar_pods_running Running pods visible to Northstar.','# TYPE northstar_pods_running gauge',`northstar_pods_running{context="${context}"} ${ps.filter(p=>p.status==='Running').length}`]; ps.forEach(p=>lines.push(`northstar_pod_status{context="${context}",namespace="${p.namespace}",pod="${p.name}",status="${p.status}"} 1`)); return `${lines.join('\n')}\n`; }
async function contexts() {
  if (process.env.NORTHSTAR_MODE !== 'kubernetes') {
    return simulatedContexts.map(x => ({ ...x, connected:false, mode:'simulated' }));
  }
  try {
    const names = await new Promise((resolve, reject) => {
      execFile(kubectl, ['config', 'get-contexts', '-o', 'name'], { maxBuffer: 1024 * 1024, env:{...process.env,...(kubeconfig?{KUBECONFIG:kubeconfig}:{})} }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      });
    });
    return names.trim().split('\n').filter(Boolean).map(name => ({ name, cluster:name, environment:name.includes('prod') ? 'Production' : name.includes('stag') ? 'Staging' : 'Development', connected:true }));
  } catch {
    return simulatedContexts.map(x => ({ ...x, connected:false, mode:'simulated' }));
  }
}
async function k8sPods(context) { const [podData,deployData]=await Promise.all([json(context,['get','pods','-A','-o','json']),json(context,['get','deployments','-A','-o','json'])]); const deployments=deployData.items; return podData.items.map(raw=>{const p=normalizePod(raw);const dep=deployments.find(d=>d.metadata.namespace===p.namespace&&Object.entries(d.spec.selector?.matchLabels||{}).every(([k,v])=>raw.metadata.labels?.[k]===v));return dep?{...p,ownerKind:'deployment',ownerName:dep.metadata.name}:p;}); }
async function k8sVersion(context) { try { const v=await json(context,['version','-o','json']); return v.serverVersion?.gitVersion || 'unknown'; } catch { return 'unknown'; } }
async function k8sMetrics(context) { try { const [podTop,nodeTop] = await Promise.all([execKubectl(context, ['top','pods','-A','--no-headers']), execKubectl(context, ['top','nodes','--no-headers'])]); const pods = podTop.trim().split('\n').filter(Boolean).map(line => { const [namespace,name,cpu,memory] = line.trim().split(/\s+/); return { namespace,name,cpu,memory }; }); const nodes = nodeTop.trim().split('\n').filter(Boolean).map(line => { const [name,cores,percent,memory,memoryPercent] = line.trim().split(/\s+/); return { name,cores,percent,memory,memoryPercent }; }); return { available:true, pods, nodes, clusterCpu:nodes.length ? Math.round(nodes.reduce((n,x)=>n+parseFloat(x.percent),0)/nodes.length*10)/10 : null, clusterMemory:nodes.length ? Math.round(nodes.reduce((n,x)=>n+parseFloat(x.memoryPercent),0)/nodes.length*10)/10 : null }; } catch { return { available:false, pods:[], nodes:[], clusterCpu:null, clusterMemory:null }; } }
function applyMetrics(pods, metrics) { const byName = new Map(metrics.pods.map(x => [`${x.namespace}/${x.name}`, x])); return pods.map(p => { const m=byName.get(`${p.namespace}/${p.name}`); return m ? { ...p, usage:`${m.cpu} / ${m.memory}` } : p; }); }
function fakePodObjects(context) { const scale = context === 'dev-sandbox' ? 0.65 : context === 'staging-west' ? 0.82 : 1; return fakePods.slice(0, Math.max(3, Math.round(fakePods.length * scale))).map((p,i) => ({ name:context === 'production-east' ? p[0] : `${p[0].split('-')[0]}-${context.slice(0,3)}-${i+1}`, namespace:context === 'production-east' ? p[1] : (context === 'staging-west' ? (i === 2 ? 'preview' : 'northstar') : (i === 2 ? 'feature-flags' : 'northstar')), status:context === 'dev-sandbox' && i === 2 ? 'CrashLoopBackOff' : p[2], usage:p[3], restarts:p[4], age:p[5], node:`${context}-node-${(i % simulated[context].nodes) + 1}`, image:p[7], cpu:Math.round(p[8] * scale), memory:Math.round(p[9] * scale), containers:['app'] })); }
function fakeWorkloads(context) { return simulated[context].workloads.map(([kind,name,namespace,desired,ready], i) => ({ kind,name,namespace,desired,ready,updated:`${i + 2}m ago`, strategy:kind === 'Deployment' ? 'RollingUpdate' : 'OnDelete' })); }
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const context = url.searchParams.get('context') || defaultContext;
  try {
    if (url.pathname === '/api/config') return send(res, 200, { readOnly, mode:process.env.NORTHSTAR_MODE === 'kubernetes' ? 'kubernetes' : 'simulated', defaultContext, prometheusConfigured:Boolean(prometheusUrl) });
    if (url.pathname === '/api/contexts') return send(res, 200, await contexts());
    if (url.pathname === '/metrics') return send(res,200,await metricsText(context),'text/plain; version=0.0.4');
    if (url.pathname === '/api/cluster') return send(res, 200, await clusterSummary(context));
    if (url.pathname === '/api/multicluster') { const list=await contexts(); const summaries=await Promise.all(list.map(c=>clusterSummary(c.name).catch(e=>({name:c.name,error:e.message,health:0,runningPods:0,totalPods:0,alerts:1,metricsAvailable:false})))); return send(res,200,summaries); }
    if (url.pathname === '/api/resource-types') { if (process.env.NORTHSTAR_MODE !== 'kubernetes') return send(res,200,[{name:'pods',kind:'Pod',namespaced:true},{name:'deployments',apiGroup:'apps',kind:'Deployment',namespaced:true},{name:'nodes',kind:'Node',namespaced:false}]); return send(res,200,await resourceCatalog(context)); }
    if (url.pathname === '/api/resources') { const resource=url.searchParams.get('resource') || 'pods'; if(!validApiResource(resource)) return send(res,400,{error:'Invalid resource type'}); const ns=url.searchParams.get('namespace'); const args=['get',resource]; if(ns&&ns!=='all') args.push('-n',ns); else args.push('-A'); args.push('-o','json'); const data=process.env.NORTHSTAR_MODE === 'kubernetes' ? await json(context,args) : {items:fakePodObjects(context).map(p=>({kind:'Pod',metadata:{name:p.name,namespace:p.namespace,creationTimestamp:new Date().toISOString()},status:{phase:p.status},spec:{containers:[{image:p.image}]}}))}; return send(res,200,(data.items||[]).map(summarizeResource)); }
    if (url.pathname === '/api/resource-yaml') { const resource=url.searchParams.get('resource') || 'pods', name=url.searchParams.get('name') || '', ns=url.searchParams.get('namespace') || ''; if(!validApiResource(resource)||!validResourcePart(name)||ns&&!validResourcePart(ns)) return send(res,400,{error:'Invalid resource request'}); const args=['get',resource,name]; if(ns) args.push('-n',ns); args.push('-o','yaml'); return send(res,200,{yaml:await execKubectl(context,args)},'application/json'); }
    if (url.pathname === '/api/describe') { const resource=url.searchParams.get('resource') || 'pods', name=url.searchParams.get('name') || '', ns=url.searchParams.get('namespace') || ''; if(!validApiResource(resource)||!validResourcePart(name)||ns&&!validResourcePart(ns)) return send(res,400,{error:'Invalid describe request'}); const args=['describe',resource,name]; if(ns) args.push('-n',ns); return send(res,200,{text:await execKubectl(context,args)},'application/json'); }
    if (url.pathname === '/api/namespaces') { if (process.env.NORTHSTAR_MODE === 'kubernetes') return send(res, 200, (await json(context,['get','namespaces','-o','json'])).items.map(x=>x.metadata.name)); return send(res, 200, simulated[context]?.namespaces || []); }
    if (url.pathname === '/api/pods') { let items; if (process.env.NORTHSTAR_MODE === 'kubernetes') { const m=await k8sMetrics(context);items=applyMetrics(await k8sPods(context),m); } else items=fakePodObjects(context); return send(res, 200, filterItems(items,url)); }
    if (url.pathname === '/api/prometheus/status') return send(res,200,{configured:Boolean(prometheusUrl),url:prometheusUrl || null});
    if (url.pathname === '/api/prometheus/query') return send(res,200,await queryPrometheus(url.searchParams.get('query') || 'up'));
    const podStream = url.pathname.match(/^\/api\/pods\/([^/]+)\/([^/]+)\/logs\/stream$/);
    if (podStream) {
      const namespace=decodeURIComponent(podStream[1]), name=decodeURIComponent(podStream[2]);
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
      let tick=0, closed=false; const write=(line,level='INFO')=>{if(!closed)res.write(`data: ${JSON.stringify({time:new Date().toISOString(),level,message:line})}\n\n`)};
      const read=async()=>{try{if(process.env.NORTHSTAR_MODE==='kubernetes'){const text=await execKubectl(context,['logs','-n',namespace,`pod/${name}`,'--all-containers=true','--since=4s']);text.trim().split('\n').filter(Boolean).forEach(line=>write(line));}else write(fakeLogs[tick++%fakeLogs.length],tick%5===0?'WARN':'INFO');}catch(e){write(e.message,'WARN')}};
      await read(); const timer=setInterval(read,3000); req.on('close',()=>{closed=true;clearInterval(timer)}); return;
    }
    const podLogs = url.pathname.match(/^\/api\/pods\/([^/]+)\/([^/]+)\/logs$/);
    if (podLogs) { const namespace = decodeURIComponent(podLogs[1]), name = decodeURIComponent(podLogs[2]); if (process.env.NORTHSTAR_MODE === 'kubernetes') { const text = await execKubectl(context,['logs',`-n`,namespace,`pod/${name}`,'--all-containers=true','--tail=100']); return send(res,200,text.trim().split('\n').filter(Boolean).map((message,i)=>({time:`live ${i+1}`,level:'INFO',message}))); } return send(res,200,fakeLogs.map((message,i)=>({time:`11:${25+i}`,level:i===4?'WARN':'INFO',message}))); }
    const podDetail = url.pathname.match(/^\/api\/pods\/([^/]+)\/([^/]+)$/);
    if (podDetail) { const namespace=decodeURIComponent(podDetail[1]), name=decodeURIComponent(podDetail[2]); const list=process.env.NORTHSTAR_MODE === 'kubernetes' ? await k8sPods(context) : fakePodObjects(context); return send(res,list.find(p=>p.name===name&&p.namespace===namespace) ? 200 : 404,list.find(p=>p.name===name&&p.namespace===namespace) || {error:'Pod not found'}); }
    if (url.pathname === '/api/workloads') { if (process.env.NORTHSTAR_MODE === 'kubernetes') { const [d,s,ds,j,c] = await Promise.all(['deployments','statefulsets','daemonsets','jobs','cronjobs'].map(kind=>json(context,['get',kind,'-A','-o','json']))); const all=[...d.items.map(x=>({...x,kind:'Deployment'})),...s.items.map(x=>({...x,kind:'StatefulSet'})),...ds.items.map(x=>({...x,kind:'DaemonSet'})),...j.items.map(x=>({...x,kind:'Job'})),...c.items.map(x=>({...x,kind:'CronJob'}))].map(x=>({kind:x.kind,name:x.metadata.name,namespace:x.metadata.namespace,desired:x.spec.replicas ?? x.status.desired ?? 1,ready:x.status.readyReplicas ?? x.status.succeeded ?? x.status.numberReady ?? 0,updated:age(x.metadata.creationTimestamp)+' ago',strategy:x.spec.strategy?.type || '—'})); return send(res,200,filterItems(all,url)); } return send(res,200,filterItems(fakeWorkloads(context),url)); }
    if (url.pathname === '/api/nodes') { if (process.env.NORTHSTAR_MODE === 'kubernetes') { const data=await json(context,['get','nodes','-o','json']); return send(res,200,data.items.map(n=>({name:n.metadata.name,status:(n.status.conditions||[]).find(x=>x.type==='Ready')?.status==='True'?'Ready':'NotReady',roles:Object.keys(n.metadata.labels||{}).filter(x=>x.startsWith('node-role.kubernetes.io/')).map(x=>x.split('/')[1]),version:n.status.nodeInfo?.kubeletVersion,capacity:n.status.capacity,conditions:(n.status.conditions||[]).filter(x=>['Ready','MemoryPressure','DiskPressure','PIDPressure'].includes(x.type)).map(x=>({type:x.type,status:x.status,reason:x.reason}))}))); } return send(res,200,Array.from({length:simulated[context].nodes},(_,i)=>({name:`${context}-node-${i+1}`,status:'Ready',roles:i===0?['control-plane']:['worker'],version:'simulated',capacity:{cpu:'4',memory:'8Gi'},conditions:[{type:'Ready',status:'True'}]}))); }
    if (url.pathname === '/api/events') { let events; if (process.env.NORTHSTAR_MODE === 'kubernetes') { const data=await json(context,['get','events','-A','--sort-by=.lastTimestamp','-o','json']); events=data.items.slice(-100).map(e=>({namespace:e.metadata.namespace,type:e.type,reason:e.reason,message:e.message,object:e.involvedObject?.name,time:e.lastTimestamp||e.eventTime||e.metadata.creationTimestamp})); } else events=[{namespace:'northstar',type:'Normal',reason:'DeploymentRolledOut',message:context==='dev-sandbox'?'feature-preview has an unavailable replica':'payments-api replicas are ready',object:'payments-api',time:new Date().toISOString()},{namespace:'northstar',type:'Warning',reason:'BackOff',message:context==='dev-sandbox'?'feature-preview container is restarting':'checkout-worker restarted once',object:'feature-preview',time:new Date(Date.now()-300000).toISOString()}]; let audited=[]; try { audited=fs.readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>!e.context||e.context===context).map(e=>({namespace:e.namespace||'northstar',type:e.outcome==='denied'?'Warning':'Normal',reason:`Audit: ${e.action}`,message:`${e.outcome}${e.reason?` (${e.reason})`:''}`,object:e.resource||'cluster',time:e.timestamp})); } catch {} return send(res,200,[...events,...audited].sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,100)); }
    if (url.pathname === '/api/alerts') { const events = process.env.NORTHSTAR_MODE === 'kubernetes' ? (await json(context,['get','events','-A','-o','json'])).items : []; return send(res,200,events.filter(e=>e.type==='Warning').slice(-20).map(e=>({severity:'warning',title:e.reason,description:e.message,namespace:e.metadata.namespace}))); }
    if (url.pathname === '/api/dashboards' && req.method === 'GET') { let dashboards=[]; try { dashboards=JSON.parse(fs.readFileSync(dashboardFile,'utf8')); } catch {} return send(res,200,dashboards); }
    if (url.pathname === '/api/dashboards' && req.method === 'POST') { const data=await body(req); let dashboards=[]; try { dashboards=JSON.parse(fs.readFileSync(dashboardFile,'utf8')); } catch {} const dashboard={id:Date.now().toString(),name:data.name||'Untitled dashboard',context:data.context||context,widgets:data.widgets||['pod-health','resource-usage','events'],createdAt:new Date().toISOString()}; dashboards.push(dashboard); fs.writeFileSync(dashboardFile,JSON.stringify(dashboards,null,2)); return send(res,201,dashboard); }
    if (url.pathname === '/api/audit' && req.method === 'GET') { let entries=[]; try { entries=fs.readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean).slice(-200).map(line=>JSON.parse(line)).reverse(); } catch {} return send(res,200,entries); }
    if (url.pathname === '/api/port-forwards' && req.method === 'GET') return send(res,200,[...portForwards.values()].map(({child,...x})=>x));
    if (url.pathname === '/api/port-forwards' && req.method === 'POST') {
      const a=await body(req), kind=String(a.kind||'pod').toLowerCase(), name=String(a.name||''), ns=String(a.namespace||''), local=Number(a.localPort), remote=Number(a.remotePort), actionContext=a.context || context;
      if (!['pod','service','deployment'].includes(kind) || !validResourcePart(name) || !validResourcePart(ns) || !Number.isInteger(local) || !Number.isInteger(remote) || local<1024 || local>65535 || remote<1 || remote>65535) return send(res,400,{error:'Invalid port-forward request'});
      if (mutationGuard(req,res,{action:'port-forward',context:actionContext,namespace:ns,resource:`${kind}/${name}`},a)) return;
      if (!(await authorizeKubernetesAction(actionContext,{...a,action:'port-forward',kind}))) { audit(req,{action:'port-forward',context:actionContext,namespace:ns,resource:`${kind}/${name}`,outcome:'denied',reason:'rbac'}); return send(res,403,{error:'Kubernetes RBAC denied port-forward',authorizationDenied:true}); }
      const id=`${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const child=spawn(kubectl, ['--context', actionContext, 'port-forward', '-n', ns, `${kind}/${name}`, `${local}:${remote}`], { env:kubectlEnv(), stdio:['ignore','pipe','pipe'] });
      const entry={id,context:actionContext,kind,name,namespace:ns,localPort:local,remotePort:remote,status:'starting',message:'Starting port-forward',createdAt:new Date().toISOString(),child};
      child.stdout.on('data', d=>{entry.status='running';entry.message=String(d).trim()||entry.message});
      child.stderr.on('data', d=>{entry.message=String(d).trim()||entry.message});
      child.on('exit', code=>{entry.status=code===0?'stopped':'failed';entry.exitCode=code;delete entry.child});
      portForwards.set(id,entry);
      audit(req,{action:'port-forward',context:actionContext,namespace:ns,resource:`${kind}/${name}`,outcome:'started',localPort:local,remotePort:remote});
      return send(res,201,{...entry,child:undefined});
    }
    const portForwardDelete = url.pathname.match(/^\/api\/port-forwards\/([^/]+)$/);
    if (portForwardDelete && req.method === 'DELETE') {
      if (readOnly) { audit(req,{action:'port-forward-stop',context,resource:portForwardDelete[1],outcome:'denied',reason:'read-only'}); return rejectReadOnly(res); }
      const item=portForwards.get(portForwardDelete[1]);
      if (!item) return send(res,404,{error:'Port-forward not found'});
      if (item.child) item.child.kill('SIGTERM');
      item.status='stopped';
      item.message='Stopped by user';
      audit(req,{action:'port-forward-stop',context:item.context,resource:`${item.kind}/${item.name}`,outcome:'stopped'});
      return send(res,200,{ok:true,id:item.id});
    }
    if (url.pathname === '/api/actions' && req.method === 'POST') { const a=await body(req); requireResource(a); const actionContext=a.context || context; const ns=a.namespace, name=a.name, kind=(a.kind||'deployment').toLowerCase(); if (mutationGuard(req,res,{action:a.action,context:actionContext,namespace:ns,resource:`${kind}/${name}`},a)) return; try { if (!(await authorizeKubernetesAction(actionContext,{...a,kind}))) { audit(req,{action:a.action,context:actionContext,namespace:ns,resource:`${kind}/${name}`,outcome:'denied',reason:'rbac'}); return send(res,403,{error:'Kubernetes RBAC denied this action',authorizationDenied:true}); } if (process.env.NORTHSTAR_MODE !== 'kubernetes') { audit(req,{action:a.action,context:actionContext,namespace:ns,resource:`${kind}/${name}`,outcome:'simulated'}); return send(res,200,{ok:true,simulated:true,message:`${a.action} simulated for ${a.name}`}); } if (a.action==='scale' && kind==='pod') return send(res,400,{error:'Pods cannot be scaled individually; scale their owning workload instead'}); if (a.action==='resources' && kind==='pod') return send(res,409,{error:'Pod resources are immutable in this cluster. Apply the resource change to its owning workload.',workloadActionRequired:true}); if (a.action==='rollout-restart' && kind==='pod') await execKubectl(actionContext,['delete','pod',name,'-n',ns]); else if (a.action==='rollout-restart') { await execKubectl(actionContext,['rollout','restart',`${kind}/${name}`,'-n',ns]); await execKubectl(actionContext,['rollout','status',`${kind}/${name}`,'-n',ns,'--timeout=30s']); } else if (a.action==='scale') { const replicas=Math.max(0,Math.min(20,Number(a.replicas))); if (!Number.isInteger(replicas)) return send(res,400,{error:'replicas must be an integer from 0 to 20'}); await execKubectl(actionContext,['scale',`${kind}/${name}`,'-n',ns,`--replicas=${replicas}`]); } else if (a.action==='resources') { const container=a.container || ''; const args=['set','resources',`${kind}/${name}`,'-n',ns]; if(container)args.push(`--containers=${container}`); if(a.requestsCpu)args.push(`--requests=cpu=${a.requestsCpu}`); if(a.requestsMemory)args.push(`--requests=memory=${a.requestsMemory}`); if(a.limitsCpu)args.push(`--limits=cpu=${a.limitsCpu}`); if(a.limitsMemory)args.push(`--limits=memory=${a.limitsMemory}`); if(args.length===5)return send(res,400,{error:'Provide at least one resource value'}); await execKubectl(actionContext,args); } else if (a.action==='delete') await execKubectl(actionContext,['delete',kind,name,'-n',ns]); else return send(res,400,{error:'Unsupported action'}); audit(req,{action:a.action,context:actionContext,namespace:ns,resource:`${kind}/${name}`,outcome:'success'}); return send(res,200,{ok:true,message:`${a.action} completed for ${name}`,context:actionContext}); } catch (error) { audit(req,{action:a.action,context:actionContext,namespace:ns,resource:`${kind}/${name}`,outcome:'error',error:error.message}); throw error; } }
    if (url.pathname === '/api/exec' && req.method === 'POST') { const a=await body(req); const actionContext=a.context || context; if (mutationGuard(req,res,{action:'exec',context:actionContext,namespace:a.namespace,resource:`pod/${a.name}`},a)) return; const command=String(a.command||'').trim(); if (!validResourcePart(a.namespace) || !validResourcePart(a.name)) return send(res,400,{error:'Invalid namespace or pod name'}); if (!validExecCommand(command)) return send(res,400,{error:'Use one safe command without shell operators'}); if (!(await authorizeKubernetesAction(actionContext,{...a,action:'exec',kind:'pod'}))) { audit(req,{action:'exec',context:actionContext,namespace:a.namespace,resource:`pod/${a.name}`,outcome:'denied',reason:'rbac'}); return send(res,403,{error:'Kubernetes RBAC denied exec',authorizationDenied:true}); } if (process.env.NORTHSTAR_MODE !== 'kubernetes') { audit(req,{action:'exec',context:actionContext,namespace:a.namespace,resource:`pod/${a.name}`,outcome:'simulated'}); return send(res,200,{output:`$ ${command}\n(simulated shell)\nNorthstar demo container is healthy.`}); } const output=await execKubectl(actionContext,['exec','-n',a.namespace,`pod/${a.name}`,'-c',a.container||'app','--','/bin/sh','-c',command]); audit(req,{action:'exec',context:actionContext,namespace:a.namespace,resource:`pod/${a.name}`,outcome:'success'}); return send(res,200,{output}); }
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res,200,fs.readFileSync(path.join(root,'index.html')),'text/html');
    return send(res,404,{error:'Not found'});
  } catch (e) { return send(res,503,{error:e.message,context}); }
}
http.createServer(route).listen(port,()=>console.log(`Northstar running at http://localhost:${port} (${process.env.NORTHSTAR_MODE === 'kubernetes' ? 'kubernetes' : 'simulated'} mode)`));
