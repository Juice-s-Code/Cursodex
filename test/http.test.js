import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
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
  async function connect(actor, fetchImplementation) {
    const transport = new StreamableHTTPClientTransport(url, {fetch:fetchImplementation,requestInit:{headers:{Authorization:'Bearer '+env['CURSODEX_'+actor.toUpperCase()+'_TOKEN']}}});
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

function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, label, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Missing HTTP lifecycle evidence: ' + label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function observeHTTP() {
  const waits = [], controls = [];
  return {
    waits, controls,
    async fetch(input, init) {
      const message = init?.method === 'POST' ? JSON.parse(init.body) : null;
      const isWait = message?.method === 'tools/call' && message.params?.name === 'cursodex_wait_events' && message.params.arguments?.wait_ms === 20000;
      const isControl = init?.method === 'DELETE' || message?.method === 'notifications/cancelled';
      const entry = isWait || isControl ? { message, method: init.method, completed: barrier() } : null;
      if (isWait) waits.push(entry);
      if (isControl) controls.push(entry);
      try {
        const response = await fetch(input, init);
        if (entry) entry.completed.resolve({ status: response.status, body: await response.clone().text() });
        return response;
      } catch (error) {
        if (entry) entry.completed.resolve({ error });
        throw error; // the genuine SDK still observes every transport failure
      }
    }
  };
}
async function beginWait(session, observation) {
  const before = observation.waits.length, controller = new AbortController();
  // Observe both branches immediately; each test asserts its specific outcome.
  const settled = session.client.callTool({ name: 'cursodex_wait_events', arguments: { after: 0, wait_ms: 20000 } },
    undefined, { signal: controller.signal, timeout: 8000, maxTotalTimeout: 8000, resetTimeoutOnProgress: false })
    .then(value => ({ value }), error => ({ error }));
  await within((async () => {
    const deadline = performance.now() + 1800;
    while (performance.now() < deadline) {
      const probe = await call(session.client, 'wait_events', { after: 0, wait_ms: 0 });
      if (probe.error?.code === 'WAIT_BUSY') return;
      assert.equal(probe.ok, true, JSON.stringify(probe));
      await delay(10);
    }
    throw new Error('SDK wait did not enter before the bounded readiness deadline');
  })(), 'long wait actually entered');
  assert.equal(observation.waits.length, before + 1);
  return { controller, settled, exchange: observation.waits[before] };
}
async function sessionStatus(url, actor, sessionId, protocolVersion) {
  const response = await fetch(url, { method: 'POST', headers: {
    Authorization: 'Bearer ' + env['CURSODEX_' + actor.toUpperCase() + '_TOKEN'],
    'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'cursodex_status', arguments: {} } }),
  signal: AbortSignal.timeout(2000) });
  await response.text();
  return response.status;
}
async function retired(url, actor, sessionId, protocolVersion) {
  await within((async () => {
    const deadline = performance.now() + 1800;
    while (performance.now() < deadline) {
      const status = await sessionStatus(url, actor, sessionId, protocolVersion);
      if (status === 404) return;
      assert.equal(status, 200, 'session must expire without capacity/auth errors');
      await delay(10);
    }
    throw new Error('Affected MCP session did not retire before the bounded deadline');
  })(), 'affected session retired');
}
async function cancelWait(wait, observation) {
  const reason = 'intentional HTTP wait cancellation';
  wait.controller.abort(new Error(reason));
  const rejected = await within(wait.settled, 'SDK cancellation rejected its pending request');
  assert.equal(rejected.value, undefined);
  assert.match(rejected.error?.message ?? '', new RegExp(reason));
  assert.deepEqual(await within(wait.exchange.completed.promise, 'cancelled request HTTP response ended'), { status: 202, body: '' });
  const control = observation.controls.find(entry => entry.message?.params?.requestId === wait.exchange.message.id);
  assert.ok(control, 'actual SDK cancellation POST was sent');
  assert.deepEqual(await within(control.completed.promise, 'SDK cancellation control acknowledged'), { status: 202, body: '' });
}

test('explicit SDK wait cancellation ends HTTP responses and requires only the affected session to reinitialize', {timeout:15000}, async t => {
  const { url, connect } = await fixture(t), observation = observeHTTP();
  const session = await connect('codex', observation.fetch), peer = await connect('cursor');
  const sessionId = session.transport.sessionId, version = session.transport.protocolVersion;
  await cancelWait(await beginWait(session, observation), observation);
  await retired(url, 'codex', sessionId, version);
  assert.equal((await call(peer.client, 'status')).data.agent, 'cursor');
  const fresh = await connect('codex');
  assert.equal((await call(fresh.client, 'status')).data.agent, 'codex');
  await fresh.client.notification({ method: 'notifications/cancelled', params: { requestId: 999999 } });
  assert.equal((await call(fresh.client, 'status')).ok, true, 'unknown cancellation must not retire the session');
});

test('DELETE during a pending SDK wait returns its genuine response and closes the abandoned request', {timeout:15000}, async t => {
  const { url, connect } = await fixture(t), observation = observeHTTP();
  const session = await connect('cursor', observation.fetch);
  const sessionId = session.transport.sessionId, version = session.transport.protocolVersion;
  const wait = await beginWait(session, observation);
  await within(session.transport.terminateSession(), 'DELETE completed');
  assert.deepEqual(await within(observation.controls.find(entry => entry.method === 'DELETE').completed.promise, 'DELETE HTTP response'), { status: 200, body: '' });
  const response = await within(wait.exchange.completed.promise, 'pending request closed by DELETE');
  assert.equal(response.status, 503);
  assert.match(JSON.parse(response.body).error, /initialize a new session/);
  const rejected = await within(wait.settled, 'pending SDK call rejected after DELETE');
  assert.equal(rejected.value, undefined);
  assert.equal(rejected.error?.code, 503);
  await retired(url, 'cursor', sessionId, version);
  assert.equal((await call((await connect('cursor')).client, 'status')).data.agent, 'cursor');
});

test('more than 32 cancellation and DELETE cycles preserve fresh-client HTTP capacity', {timeout:30000}, async t => {
  const { url, connect } = await fixture(t);
  for (let index = 0; index < 34; index++) {
    const actor = index % 2 ? 'cursor' : 'codex', observation = observeHTTP();
    const session = await connect(actor, observation.fetch);
    const sessionId = session.transport.sessionId, version = session.transport.protocolVersion;
    const wait = await beginWait(session, observation);
    if (index % 2 === 0) await cancelWait(wait, observation);
    else {
      await within(session.transport.terminateSession(), 'capacity-cycle DELETE');
      assert.equal((await within(wait.exchange.completed.promise, 'capacity-cycle pending HTTP request')).status, 503);
      const rejected = await within(wait.settled, 'capacity-cycle pending SDK request');
      assert.equal(rejected.value, undefined);
      assert.equal(rejected.error?.code, 503);
    }
    await retired(url, actor, sessionId, version);
    await session.client.close();
  }
  for (const actor of ['codex', 'cursor']) {
    const status = await call((await connect(actor)).client, 'status');
    assert.equal(status.ok, true);
    assert.equal(status.data.agent, actor);
  }
});

test('disconnecting an unfinished SDK response retires its session and frees admission', {timeout:15000}, async t => {
  const { url, connect } = await fixture(t), observation = observeHTTP();
  const session = await connect('codex', observation.fetch);
  const sessionId = session.transport.sessionId, version = session.transport.protocolVersion;
  const wait = await beginWait(session, observation);
  await session.client.close();
  const rejected = await within(wait.settled, 'disconnected SDK request rejected');
  assert.equal(rejected.value, undefined);
  assert.match(rejected.error?.message ?? '', /closed/i);
  assert.ok((await within(wait.exchange.completed.promise, 'original HTTP fetch disconnected')).error);
  await retired(url, 'codex', sessionId, version);
  assert.equal((await call((await connect('codex')).client, 'status')).ok, true);
});

test('shutdown with a dispatched wait closes the real HTTP exchange within a finite bound', {timeout:10000}, async t => {
  const { connect, cloud } = await fixture(t), observation = observeHTTP();
  const session = await connect('codex', observation.fetch), wait = await beginWait(session, observation);
  const first = cloud.close(), second = cloud.close();
  assert.equal(first, second);
  await within(first, 'shutdown completed');
  assert.equal(cloud.server.listening, false);
  const response = await within(wait.exchange.completed.promise, 'shutdown pending HTTP request closed');
  if (response.error) assert.match(response.error.message, /fetch failed|closed|socket/i);
  else assert.equal(response.status, 503);
  const rejected = await within(wait.settled, 'shutdown pending SDK request rejected');
  assert.equal(rejected.value, undefined);
  assert.match(rejected.error?.message ?? '', /503|fetch failed|closed|socket/i);
});
