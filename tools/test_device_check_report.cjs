// Pure text tests only: no server, discovery, sockets or browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CRLF = String.fromCharCode(13, 10), BOM = String.fromCharCode(0xFEFF);
const sourcePath = path.resolve(__dirname, '../web/device-check-report.js');
const ports = [21, 22, 23, 80, 443, 445, 3389];
function fixture() {
  const device = { deviceKey: 'fixture-peer', ip: '192.0.2.30', kind: 'device', hostname: '示例存储', mac: '02:00:00:00:00:30', profile: { alias: '客厅设备', notes: 'PRIVATE-NOTE' } };
  return {
    result: { networkId: 'fixture-network', scanId: 17, scannedAt: '2026-11-20T09:10:11Z', devices: [device] },
    device,
    check: { networkId: 'fixture-network', deviceKey: 'fixture-peer', scanId: 17, status: 'complete', completed: 7, total: 7, results: ports.map((port, index) => ({ port, status: ['closed', 'open', 'no_response', 'unavailable'][index % 4], service: 'UNTRUSTED-SERVICE' })) },
    exportedAt: '2026-11-20T10:11:12Z',
  };
}
async function run() {
  assert.ok(fs.existsSync(sourcePath), 'a pure service-check report builder must exist');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { buildDeviceCheckReport } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(typeof buildDeviceCheckReport, 'function');
  const tests = [], test = (name, body) => tests.push([name, body]);
  test('complete report includes seven ordered observations and plain meanings', () => {
    const report = buildDeviceCheckReport(fixture());
    assert.ok(report.startsWith(BOM + 'NetSpace 服务检查报告' + CRLF));
    assert.ok(!report.split(CRLF).some(line => line.includes(String.fromCharCode(10))), 'Windows report uses CRLF');
    for (const expected of ['设备名称：客厅设备', 'IP 地址：192.0.2.30', '发现时间（不是检查时间）：2026-11-20T09:10:11.000Z', '报告生成时间（不是检查时间）：2026-11-20T10:11:12.000Z', '任务状态：已完成', '已检查端口：7 / 7', '可连接', '拒绝连接', '未响应', '不可用', '不等于存在漏洞', '不会发起新的检查']) assert.ok(report.includes(expected), expected);
    const rows = report.split(CRLF).filter(line => line.startsWith('TCP '));
    assert.deepEqual(rows.map(line => Number(line.split(' ')[1])), ports);
    assert.match(report, /无法判断.*是否开放/);
    assert.match(report, /常见用途.*不.*识别/);
    assert.match(report, /隐私.*名称.*IP/);
  });
  test('cancelled report marks unobserved ports untested and derives its count', () => {
    const input = fixture(); input.check.status = 'cancelled'; input.check.results = input.check.results.slice(0, 2); input.check.completed = 999;
    const report = buildDeviceCheckReport(input);
    assert.ok(report.includes('任务状态：已取消')); assert.ok(report.includes('已检查端口：2 / 7'));
    assert.equal(report.split(CRLF).filter(line => line.startsWith('TCP ') && line.endsWith('未检查')).length, 5);
    assert.ok(!report.includes('999'));
  });
  test('error report preserves partial observations without claiming completion', () => {
    const input = fixture(); input.check.status = 'error'; input.check.results = [input.check.results[6]];
    const report = buildDeviceCheckReport(input);
    assert.ok(report.includes('任务状态：检查未完成')); assert.ok(report.includes('已检查端口：1 / 7'));
    assert.equal(report.split(CRLF).filter(line => line.startsWith('TCP ') && line.endsWith('未检查')).length, 6);
  });
  test('network device and scan identity all must match', () => {
    for (const [field, value] of [['networkId', 'other-network'], ['deviceKey', 'other-device'], ['scanId', 18]]) {
      const input = fixture(); input.check[field] = value;
      assert.throws(() => buildDeviceCheckReport(input), /匹配|对应/);
    }
    const input = fixture(); delete input.result.scanId; delete input.check.scanId;
    assert.throws(() => buildDeviceCheckReport(input), /匹配|对应/);
  });
  test('detached addresses and the local machine cannot borrow a peer identity', () => {
    const input = fixture(); input.device = { ...input.device, ip: '192.0.2.31' };
    assert.throws(() => buildDeviceCheckReport(input), /匹配|对应/);
    input.device = { ...input.result.devices[0], kind: 'self' };
    assert.throws(() => buildDeviceCheckReport(input), /匹配|对应|本机/);
  });
  test('ongoing idle and empty terminal results cannot be exported', () => {
    for (const status of ['checking', 'idle', 'unknown']) {
      const input = fixture(); input.check.status = status;
      assert.throws(() => buildDeviceCheckReport(input), /结果|完成/);
    }
    for (const status of ['complete', 'cancelled', 'error']) {
      const input = fixture(); input.check.status = status; input.check.results = [];
      assert.throws(() => buildDeviceCheckReport(input), /结果|完整/);
    }
  });
  test('complete reports cannot hide a missing observation', () => {
    const input = fixture(); input.check.results.pop();
    assert.throws(() => buildDeviceCheckReport(input), /完整|结果/);
  });
  test('unsupported duplicated or unrecognized observations are rejected', () => {
    for (const row of [{ port: 9999, status: 'open' }, { port: 21, status: 'vulnerable' }, { port: 21, status: 'open' }]) {
      const input = fixture(); input.check.results.push(row);
      assert.throws(() => buildDeviceCheckReport(input), /结果|端口/);
    }
  });
  test('untrusted service labels and unnecessary personal fields are omitted', () => {
    const input = fixture(), before = JSON.stringify(input), report = buildDeviceCheckReport(input);
    for (const excluded of ['UNTRUSTED-SERVICE', 'PRIVATE-NOTE', '02:00:00:00:00:30']) assert.ok(!report.includes(excluded));
    assert.equal(JSON.stringify(input), before, 'report creation never mutates its inputs');
  });
  test('multiline names cannot inject lines or hide direction controls', () => {
    const input = fixture(), controls = [0, 0x202E, 0x200B, 0x85].map(code => String.fromCharCode(code));
    input.device.profile.alias = '中文' + CRLF + '任务状态：伪造' + controls.join('') + '名称';
    const report = buildDeviceCheckReport(input);
    assert.equal(report.split(CRLF).filter(line => line.startsWith('任务状态：')).length, 1);
    assert.match(report.split(CRLF).find(line => line.startsWith('设备名称：')), /中文.*任务状态：伪造.*名称/);
    for (const control of controls) assert.ok(!report.includes(control));
  });
  test('malformed timestamps cannot add forged report rows', () => {
    const input = fixture(); input.exportedAt = 'invalid' + CRLF + '任务状态：伪造'; input.result.scannedAt = 'invalid' + String.fromCharCode(10) + 'TCP 9999';
    const report = buildDeviceCheckReport(input);
    assert.ok(report.includes('发现时间（不是检查时间）：未记录')); assert.ok(report.includes('报告生成时间（不是检查时间）：未记录'));
    assert.ok(!report.includes('伪造')); assert.ok(!report.includes('9999'));
  });
  let passed = 0;
  for (const [name, body] of tests) { body(); passed++; console.log('PASS ' + name); }
  console.log('Pure service-check report tests passed: ' + passed + '; no network operations.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
