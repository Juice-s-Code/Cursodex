import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCloud } from '../src/http.js';
const env = { CURSODEX_CODEX_TOKEN: 'c'.repeat(48), CURSODEX_CURSOR_TOKEN: 'u'.repeat(48) };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-cloud-'));
  const cloud = await startCloud({projectRoot:root,port:0,env,log:false,signalHandlers:false});
  const url = new URL('http://127.0.0.1:' + cloud.address.port + '/mcp');
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(x => x.client.close())); await cloud.close(); await rm(root,{recursive:true,force:true}); });
  async function connect(actor) {
    const transport = new StreamableHTTPClientTransport(url, {requestInit:{headers:{Authorization:'Bearer '+env['CURSODEX_'+actor.toUpperCase()+'_TOKEN']}}});
    const client = new Client({name:'cloud-'+actor,version:'1'}); clients.push({client,transport});
    await client.connect(transport); return {client,transport};
  }
  return {url,connect,root,cloud};
}
const call = async (c,name,args={}) => (await c.callTool({name:'cursodex_'+name,arguments:args})).structuredContent;
test('authenticated HTTP clients share messages, tasks and memory across actor-scoped sessions', {timeout:15000}, async t => {
  const {url,connect} = await fixture(t), a = await connect('codex'), b = await connect('cursor');
  assert.equal((await call(a.client,'status')).data.agent,'codex');
  assert.equal((await call(b.client,'status')).data.agent,'cursor');
  const sent = (await call(a.client,'send_message',{recipient:'cursor',key:'cloud-challenge',body:'Read our shared goal and reply with the task.'})).data;
  await call(a.client,'put_memory',{name:'goal',expected_revision:0,body:'A visible shared plan.'});
  const task = (await call(a.client,'create_task',{key:'cloud-task',assignee:'cursor',title:'Verify cloud coordination'})).data;
  assert.equal((await call(b.client,'get_memory',{name:'goal'})).data.body,'A visible shared plan.');
  assert.equal((await call(b.client,'list_messages')).data.items[0].id,sent.id);
  await call(b.client,'ack_message',{id:sent.id});
  const reply = await call(b.client,'send_message',{recipient:'codex',key:'cloud-reply',body:'Task '+task.id+' read.',reply_to:sent.id});
  assert.equal((await call(a.client,'list_messages')).data.items[0].id,reply.data.id);
  const crossActor = await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+env.CURSODEX_CURSOR_TOKEN,'mcp-session-id':a.transport.sessionId,'Content-Type':'application/json'},body:'{}'});
  assert.equal(crossActor.status,403);
  const third = await connect('codex');
  assert.equal((await call(third.client,'get_task',{id:task.id})).data.title,'Verify cloud coordination');
  await b.transport.terminateSession();
  const dead = await fetch(url,{method:'DELETE',headers:{Authorization:'Bearer '+env.CURSODEX_CURSOR_TOKEN,'mcp-session-id':b.transport.sessionId ?? 'expired'}});
  assert.equal(dead.status,404);
});
test('HTTP refuses absent or wrong credentials, unexpected origin/host, malformed and oversized bodies', {timeout:15000}, async t => {
  const {url,connect} = await fixture(t);
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer wrong'},body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,Origin:'https://untrusted.invalid'},body:'{}'})).status,403);
  const wrongHost = await new Promise((resolve,reject) => {
    const req = request(url,{method:'POST',headers:{Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,Host:'untrusted.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject); req.end('{}');
  });
  assert.equal(wrongHost,403);
  const headers = {Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,'Content-Type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',headers,body:'{' })).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:'null',signal:AbortSignal.timeout(2000)})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:'x'.repeat(65537)})).status,413);
  assert.equal((await fetch(url,{method:'POST',headers,body:Buffer.from([123,34,0xff,34,58,49,125])})).status,400);
  const a = await connect('codex');
  const spoof = await a.client.callTool({name:'cursodex_send_message',arguments:{recipient:'cursor',key:'spoof',body:'x',actor:'cursor'}});
  assert.equal(spoof.isError,true);
  assert.equal((await call(a.client,'list_messages',{direction:'sent'})).data.count,0);
});
test('cloud credentials must be strong and actor-distinct before state creation', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'cursodex-cloud-config-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for (const value of [{}, {...env,CURSODEX_CODEX_TOKEN:'short'}, {...env,CURSODEX_CURSOR_TOKEN:env.CURSODEX_CODEX_TOKEN}])
    await assert.rejects(startCloud({projectRoot:root,port:0,env:value,log:false,signalHandlers:false}),/distinct/);
});
test('chunked request byte cap holds without trusting Content-Length', {timeout:15000}, async t => {
  const {url} = await fixture(t);
  const status = await new Promise((resolve,reject) => {
    const req = request(url,{method:'POST',headers:{Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,'Content-Type':'application/json'}},res=>{res.resume(); res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject); req.write('x'.repeat(40000)); req.end('y'.repeat(40000));
  });
  assert.equal(status,413);
});
test('session capacity bounds concurrent initialization and a deleted session frees capacity', {timeout:15000}, async t => {
  const {url,connect} = await fixture(t);
  const init = {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'capacity-test',version:'1'}}};
  const responses = await Promise.all(Array.from({length:17},()=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(init)})));
  assert.equal(responses.filter(x=>x.status===200).length,16);
  assert.equal(responses.filter(x=>x.status===429).length,1);
  const session = responses.find(x=>x.status===200).headers.get('mcp-session-id');
  await Promise.all(responses.map(x=>x.text()));
  const deleted = await fetch(url,{method:'DELETE',headers:{Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,'mcp-session-id':session,'mcp-protocol-version':'2025-11-25'}});
  assert.equal(deleted.status,200);
  const renewed = await connect('cursor');
  assert.equal((await call(renewed.client,'status')).data.agent,'cursor');
});
test('shutdown closes an incomplete initialization body and repeated close awaits the same shutdown', {timeout:10000}, async t => {
  const {url,cloud} = await fixture(t);
  let initialized = false;
  const done = new Promise(resolve => {
    const req = request(url,{method:'POST',headers:{Authorization:'Bearer '+env.CURSODEX_CODEX_TOKEN,'Content-Type':'application/json'}},res=>{
      initialized = res.statusCode === 200 || Boolean(res.headers['mcp-session-id']); res.resume(); res.on('end',resolve);
    });
    req.on('error',resolve);
    req.flushHeaders(); req.write('{"jsonrpc":"2.0",');
    setImmediate(() => { const first = cloud.close(), second = cloud.close(); assert.equal(first,second); void first.then(resolve); });
  });
  await done;
  assert.equal(initialized,false);
  await cloud.close();
  assert.equal(cloud.server.listening,false);
});
