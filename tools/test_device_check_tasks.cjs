// In-memory task ordering tests only: no server, browser, scan or socket.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
  constructor() {
    this.textContent = ''; this.checked = false; this.disabled = false;
    this.hidden = false; this.open = false; this.handlers = {};
    this.dataset = {}; this.children = [];
  }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  click() { if (!this.disabled) return this.handlers.click?.(); }
}

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function loadController() {
  const reportSource = fs.readFileSync(path.join(__dirname, '../web/device-check-report.js'), 'utf8');
  const reportModule = 'data:text/javascript;base64,' + Buffer.from(reportSource).toString('base64');
  const source = fs.readFileSync(path.join(__dirname, '../web/device-check.js'), 'utf8')
    .replace("'./device-check-report.js'", JSON.stringify(reportModule));
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createDeviceCheck;
}

function harness(createDeviceCheck, api) {
  const originals = Object.fromEntries(['document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch'].map(key => [key, globalThis[key]]));
  let nextTimer = 0, renders = 0; const timers = new Map();
  globalThis.document = { createElement: () => new FakeElement(), body: new FakeElement() };
  globalThis.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.setInterval = () => -1; globalThis.clearInterval = () => {};
  globalThis.fetch = () => { throw new Error('Network access is forbidden in in-memory task tests'); };
  const ui = new Proxy({}, { get: (object, key) => object[key] ||= new FakeElement() });
  const device = { deviceKey: 'fixture-peer', ip: '192.0.2.30', hostname: '示例设备', kind: 'device' };
  const current = { result: { networkId: 'fixture-network', scanId: 17, scannedAt: new Date().toISOString(), devices: [device] }, device, current: true };
  const a = { networkId: current.result.networkId, deviceKey: device.deviceKey, scanId: 17,
    runId: 'a'.repeat(32), status: 'checking', completed: 0, total: 7, results: [] };
  const done = { ...a, status: 'complete', completed: 7,
    results: [21, 22, 23, 80, 443, 445, 3389].map(port => ({ port, status: 'closed' })) };
  const b = { ...a, runId: 'b'.repeat(32), completed: 2, results: done.results.slice(0, 2) };
  const task = createDeviceCheck({ ui, api: (...args) => api(...args), readContext: () => current, rerender: () => { renders++; } });
  task.sync();
  return { ui, task, a, b, done, get renders() { return renders; },
    open() { ui['device-check-open'].click(); },
    async start() { ui['device-check-consent'].checked = true; ui['device-check-consent'].handlers.change(); await ui['device-check-start'].click(); },
    poll() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 450);
      assert.ok(entry, 'a running task schedules a read'); timers.delete(entry[0]);
      return entry[1].callback();
    },
    dispose() { task.destroy(); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } },
  };
}

async function run() {
  const createDeviceCheck = await loadController();
  const tests = [], test = (name, body) => tests.push([name, body]);
  test('a late cancel read cannot replace a newer explicitly started task', async () => {
    const oldRead = deferred(), readStarted = deferred(); let starts = 0, h;
    h = harness(createDeviceCheck, async (url, options) => {
      if (options?.method === 'POST') {
        if (url.endsWith('/cancel')) return { cancelled: true };
        starts++; return h.b;
      }
      readStarted.resolve(); return oldRead.promise;
    });
    try {
      h.task.observe(h.a); h.open();
      const cancel = h.ui['device-check-cancel'].click(); await readStarted.promise;
      // A background workspace response can arrive while the cancellation read waits.
      h.task.observe(h.done); await h.start();
      assert.equal(starts, 1, 'one explicit new start should create task B');
      assert.match(h.ui['device-check-status'].textContent, /正在检查：2 \/ 7/);
      oldRead.resolve(h.done); await cancel;
      assert.match(h.ui['device-check-status'].textContent, /正在检查：2 \/ 7/, 'old cancellation data must not overwrite the newer task');
      assert.equal(h.ui['device-check-export'].disabled, true, 'old completed data cannot enable a report for the active task');
      assert.equal(h.ui['device-check-cancel'].disabled, false, 'the newer task stays cancellable');
    } finally { oldRead.resolve(h.done); h.dispose(); }
  });
  test('destroying a view prevents a pending cancellation read from rendering', async () => {
    const oldRead = deferred(), readStarted = deferred(); let h;
    h = harness(createDeviceCheck, async (url, options) => {
      if (options?.method === 'POST') return { cancelled: true };
      readStarted.resolve(); return oldRead.promise;
    });
    try {
      h.task.observe(h.a); h.open();
      const cancel = h.ui['device-check-cancel'].click(); await readStarted.promise;
      h.task.destroy(); const rendersAfterDestroy = h.renders;
      oldRead.resolve(h.done); await cancel;
      assert.equal(h.renders, rendersAfterDestroy, 'a destroyed view must not render an old response');
    } finally { oldRead.resolve(h.done); h.dispose(); }
  });
  test('an old poll cannot replace cancellation results for the same run', async () => {
    const oldRead = deferred(), readStarted = deferred(); let reads = 0, h;
    h = harness(createDeviceCheck, async (url, options) => {
      if (options?.method === 'POST') return url.endsWith('/cancel') ? { cancelled: true } : h.a;
      if (++reads === 1) { readStarted.resolve(); return oldRead.promise; }
      return { ...h.a, status: 'cancelled', completed: 2, results: h.done.results.slice(0, 2) };
    });
    try {
      h.open(); await h.start(); const poll = h.poll(); await readStarted.promise;
      await h.ui['device-check-cancel'].click();
      assert.match(h.ui['device-check-status'].textContent, /已取消.*2 \/ 7/);
      oldRead.resolve(h.done); await poll;
      assert.match(h.ui['device-check-status'].textContent, /已取消.*2 \/ 7/, 'cancellation results survive a delayed poll of the same run');
      assert.equal(h.ui['device-check-results'].children.length, 2);
    } finally { oldRead.resolve(h.done); h.dispose(); }
  });
  let passed = 0; const failures = [];
  for (const [name, body] of tests) {
    try { await body(); passed++; console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
  }
  console.log('In-memory task ordering tests: ' + passed + '/' + tests.length + '; no network operations.');
  if (failures.length) process.exitCode = 1;
}
run().catch(error => { console.error(error); process.exitCode = 1; });
