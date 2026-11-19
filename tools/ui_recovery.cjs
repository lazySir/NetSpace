// Optional browser recovery checks. Run against the local source server on port 8765.
// Uses isolated API fixtures; no LAN scans or external requests are made.
const assert = require('node:assert/strict');
const { chromium } = require('../.tools/qa/node_modules/playwright');
const base = process.env.NETSPACE_URL || 'http://127.0.0.1:8765';
const executablePath = process.env.NETSPACE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const adapterA = { id: 'A', alias: 'Adapter A', ip: '192.168.1.20', gateway: '192.168.1.1', prefixLength: 24, cidr: '192.168.1.0/24', scanCidr: '192.168.1.0/24', scopeLimited: false };
const adapterB = { id: 'B', alias: 'Adapter B', ip: '192.168.2.20', gateway: '192.168.2.1', prefixLength: 24, cidr: '192.168.2.0/24', scanCidr: '192.168.2.0/24', scopeLimited: false };

function result(adapter) {
  return {
    interface: adapter,
    devices: [{ id: adapter.ip, ip: adapter.ip, hostname: adapter.alias, kind: 'self', status: 'online', mac: null, evidence: ['本机已连接的 IPv4 网络接口'], latencyMs: null }],
    links: [], scannedAt: '2026-11-19T10:20:30+08:00', durationMs: 10, warnings: [],
    scope: { cidr: adapter.cidr, scanCidr: adapter.scanCidr, targetCount: 253, limited: false },
  };
}
function state(status, item = null, error = null) {
  return { status, result: item, error, progress: { phase: status, completed: status === 'complete' ? 253 : 10, total: 253, message: status === 'scanning' ? '正在发现设备' : '设备发现完成' } };
}
async function visibleAdapter(page, adapter) {
  await page.waitForFunction((expected) => document.querySelector('#interface-select').value === expected.id && document.querySelector('#device-list').textContent.includes(expected.ip), adapter);
  const list = await page.locator('#device-list').innerText();
  assert.equal(list.includes(adapter === adapterA ? adapterB.ip : adapterA.ip), false, 'results from the other adapter must not be shown');
  assert.equal(Number(await page.locator('#stat-total').innerText()), 1);
}
async function withPage(context, run) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try { await run(page); assert.deepEqual(errors, [], 'recovery flow must have no runtime errors'); }
  finally { await page.close(); }
}

async function adapterReplacement(context) {
  await withPage(context, async (page) => {
    let adapters = [adapterA];
    let current = state('complete', result(adapterA));
    let adapterReads = 0;
    let scanCalls = 0;
    await page.route('**/api/interfaces', (route) => { adapterReads++; return route.fulfill({ json: { interfaces: adapters, error: null } }); });
    await page.route('**/api/state', (route) => route.fulfill({ json: current }));
    await page.route('**/api/scan', (route) => {
      scanCalls++;
      if (scanCalls === 1) return route.fulfill({ status: 500, json: { error: 'Adapter A disconnected' } });
      assert.equal(route.request().postDataJSON().interfaceId, 'B', 'retry must use newly enumerated B');
      current = state('complete', result(adapterB));
      return route.fulfill({ status: 202, json: current });
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await visibleAdapter(page, adapterA);
    await page.locator('#scan-button').click();
    await page.locator('#notice').filter({ hasText: 'Adapter A disconnected' }).waitFor();
    assert.ok((await page.locator('#device-list').innerText()).includes(adapterA.ip), 'last known result remains reviewable after failure');
    adapters = [adapterB]; current = state('idle');
    await page.locator('#scan-button').click();
    await visibleAdapter(page, adapterB);
    assert.equal(adapterReads, 2, 'retry re-enumerates adapters exactly once');
    assert.equal(scanCalls, 2, 'retry starts exactly one B scan');
  });
}

async function resumeExistingScan(context) {
  await withPage(context, async (page) => {
    let reads = 0;
    let scanCalls = 0;
    await page.route('**/api/interfaces', (route) => route.fulfill({ json: { interfaces: [adapterA, adapterB], error: null } }));
    await page.route('**/api/state', (route) => { reads++; return route.fulfill({ json: reads === 1 ? state('scanning', result(adapterA)) : state('complete', result(adapterB)) }); });
    await page.route('**/api/scan', (route) => { scanCalls++; return route.fulfill({ status: 500, json: { error: 'A joined scan must not start another scan' } }); });
    await page.goto(base, { waitUntil: 'networkidle' });
    await visibleAdapter(page, adapterB);
    assert.equal(reads, 2, 'reopening follows the running scan with one state poll');
    assert.equal(scanCalls, 0, 'reopening does not initiate a duplicate scan');
    await page.waitForTimeout(1050);
    assert.equal(reads, 2, 'polling stops after completion');
  });
}

async function conflictWhileDemo(context) {
  await withPage(context, async (page) => {
    let reads = 0;
    let scanCalls = 0;
    let completeB = false;
    await page.route('**/api/interfaces', (route) => route.fulfill({ json: { interfaces: [adapterA, adapterB], error: null } }));
    await page.route('**/api/state', (route) => {
      reads++;
      const current = reads === 1 ? state('complete', result(adapterA)) : completeB ? state('complete', result(adapterB)) : state('scanning', result(adapterA));
      return route.fulfill({ json: current });
    });
    await page.route('**/api/scan', (route) => { scanCalls++; return route.fulfill({ status: 409, json: { error: 'Adapter B discovery is already running' } }); });
    await page.goto(base, { waitUntil: 'networkidle' });
    await visibleAdapter(page, adapterA);
    await page.locator('#scan-button').click();
    await page.waitForFunction(() => !document.querySelector('#scan-progress').hidden);
    await page.waitForFunction(() => document.querySelector('#scan-button').disabled);
    await page.locator('#demo-toggle').click();
    await page.locator('#demo-banner').waitFor({ state: 'visible' });
    const demoCount = Number(await page.locator('#stat-total').innerText());
    assert.ok(demoCount > 1);
    completeB = true;
    await page.waitForFunction(() => document.querySelector('#interface-select').value === 'B');
    assert.equal(await page.locator('#demo-banner').isVisible(), true, 'real completion must not dismiss the demo marker');
    assert.equal(Number(await page.locator('#stat-total').innerText()), demoCount, 'real completion must not overwrite demo devices');
    assert.equal((await page.locator('#device-list').innerText()).includes(adapterB.ip), false, 'real B devices must stay separate during demo');
    await page.locator('#leave-demo').click();
    await visibleAdapter(page, adapterB);
    assert.equal(scanCalls, 1, '409 recovery joins the existing scan instead of starting a second one');
  });
}

async function conflictAlreadyComplete(context) {
  await withPage(context, async (page) => {
    let reads = 0;
    await page.route('**/api/interfaces', (route) => route.fulfill({ json: { interfaces: [adapterA, adapterB], error: null } }));
    await page.route('**/api/state', (route) => { reads++; return route.fulfill({ json: state('complete', result(reads === 1 ? adapterA : adapterB)) }); });
    await page.route('**/api/scan', (route) => route.fulfill({ status: 409, json: { error: 'Another discovery has just finished' } }));
    await page.goto(base, { waitUntil: 'networkidle' });
    await visibleAdapter(page, adapterA);
    await page.locator('#scan-button').click();
    await visibleAdapter(page, adapterB);
    assert.equal(reads, 2, 'completed 409 recovery needs no polling');
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const checks = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await adapterReplacement(context); checks.push('adapter A disconnect → re-enumerate B → one B scan');
    await resumeExistingScan(context); checks.push('reopen during B scan with old A result → select completed B');
    await conflictWhileDemo(context); checks.push('409 joins B scan → demo stays isolated → return to completed B');
    await conflictAlreadyComplete(context); checks.push('409 scan completes before state fetch → select B without polling');
    console.log(JSON.stringify({ result: 'PASS', checks }, null, 2));
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
