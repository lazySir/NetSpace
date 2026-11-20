// Pure saved-device search tests: no server, discovery, sockets or browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sourcePath = path.resolve(__dirname, '../web/archive-search.js');
const fusePath = path.resolve(__dirname, '../web/vendor/fuse.min.js');
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const keys = records => records.map(record => record.deviceKey);

async function run() {
  assert.ok(fs.existsSync(sourcePath), 'a pure saved-device archive search module must exist');
  const fuseUrl = moduleUrl(fs.readFileSync(fusePath, 'utf8'));
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/from (['"])\/vendor\/fuse\.min\.js\1/, 'from ' + JSON.stringify(fuseUrl));
  const { createArchiveIndex } = await import(moduleUrl(source));
  assert.equal(typeof createArchiveIndex, 'function');
  const tests = [], test = (name, body) => tests.push([name, body]);

  test('an empty query returns original records in saved order', () => {
    const records = [{ deviceKey: 'z', hostname: 'Zulu' }, { deviceKey: 'a', hostname: 'Alpha' }, { deviceKey: 'bare' }];
    const index = createArchiveIndex(records);
    assert.deepEqual(keys(index.search()), ['z', 'a', 'bare']);
    assert.deepEqual(keys(index.search('   ')), ['z', 'a', 'bare']);
    assert.equal(index.search()[0], records[0]);
    assert.equal(index.search()[1], records[1]);
  });
  test('missing means present is exactly false', () => {
    const index = createArchiveIndex([
      { deviceKey: 'missing', present: false }, { deviceKey: 'present', present: true },
      { deviceKey: 'unknown' }, { deviceKey: 'zero', present: 0 },
    ]);
    assert.deepEqual(keys(index.search('', 'missing')), ['missing']);
  });
  test('review excludes self known and ignored records', () => {
    const index = createArchiveIndex([
      { deviceKey: 'new-peer', kind: 'device', profile: { known: false, ignored: false } },
      { deviceKey: 'bare-peer', kind: 'device' },
      { deviceKey: 'self', kind: 'self', profile: { known: false } },
      { deviceKey: 'known', kind: 'device', present: false, profile: { known: true } },
      { deviceKey: 'ignored', kind: 'device', profile: { ignored: true } },
    ]);
    assert.deepEqual(keys(index.search('', 'review')), ['new-peer', 'bare-peer']);
  });
  test('query results intersect the selected mode', () => {
    const index = createArchiveIndex([
      { deviceKey: 'missing', hostname: 'Kitchen sensor', present: false },
      { deviceKey: 'present', hostname: 'Kitchen lamp', present: true },
      { deviceKey: 'known', hostname: 'Kitchen speaker', profile: { known: true } },
    ]);
    assert.deepEqual(keys(index.search('kitchen', 'missing')), ['missing']);
    assert.deepEqual(keys(index.search('kitchen', 'review')), ['missing', 'present']);
  });
  test('unsupported modes fail closed for empty and nonempty queries', () => {
    const index = createArchiveIndex([{ deviceKey: 'peer', hostname: 'Printer' }]);
    for (const mode of ['unknown', '__proto__', 'constructor', '', null]) {
      assert.deepEqual(index.search('', mode), []);
      assert.deepEqual(index.search('printer', mode), []);
    }
  });
  test('a small alias typo still finds the saved device', () => {
    const peer = { deviceKey: 'printer', profile: { alias: 'Kitchen printer' } };
    const index = createArchiveIndex([peer, { deviceKey: 'other', hostname: 'Garage television' }]);
    assert.deepEqual(keys(index.search('kithcen printer')), ['printer']);
    assert.equal(index.search('kithcen printer')[0], peer);
  });
  test('names hostnames and groups support conservative fuzzy matching', () => {
    const cases = [
      [{ deviceKey: 'name', name: 'Study projector' }, 'stody projector', 'name'],
      [{ deviceKey: 'display', displayName: 'Garden camera' }, 'gardan camera', 'display'],
      [{ deviceKey: 'hostname', hostname: 'Office scanner' }, 'offcie scanner', 'hostname'],
      [{ deviceKey: 'group', profile: { group: 'Living room' } }, 'livng room', 'group'],
    ];
    for (const [record, query, expected] of cases) assert.deepEqual(keys(createArchiveIndex([record]).search(query)), [expected]);
  });
  test('literal text fragments are case insensitive and preserve saved order', () => {
    const index = createArchiveIndex([
      { deviceKey: 'group', profile: { group: 'Storage [x]+' } },
      { deviceKey: 'alias', profile: { alias: 'Lower storage [x]+' } },
      { deviceKey: 'hostname', hostname: 'UPPER STORAGE [x]+' },
    ]);
    assert.deepEqual(keys(index.search('STORAGE [x]+')), ['group', 'alias', 'hostname']);
  });
  test('IP fragments match literally and nearby IPs never match fuzzily', () => {
    const index = createArchiveIndex([
      { deviceKey: 'thirty', ip: '192.0.2.30' },
      { deviceKey: 'thirty-one', ip: '192.0.2.31' },
      { deviceKey: 'near-name', hostname: '192.0.2.39 Printer' },
    ]);
    assert.deepEqual(keys(index.search('192.0.2.3')), ['thirty', 'thirty-one', 'near-name']);
    assert.deepEqual(keys(index.search('192.0.2.40')), []);
    assert.deepEqual(keys(index.search('192.0.2.30')), ['thirty']);
  });
  test('numeric fragments do not fuzzy-match a nearby number in a name', () => {
    const index = createArchiveIndex([
      { deviceKey: 'address', ip: '203.0.113.20' },
      { deviceKey: 'name', hostname: '204' },
    ]);
    assert.deepEqual(keys(index.search('203')), ['address']);
  });
  test('dotted IP fragments cannot turn into compact MAC fragments', () => {
    const index = createArchiveIndex([{ deviceKey: 'mac', mac: '19:20:23:00:00:00' }]);
    assert.deepEqual(index.search('192.0.2.3'), []);
    assert.deepEqual(index.search('20.23'), []);
  });
  test('MAC fragments match with separators or compact spelling regardless of case', () => {
    const index = createArchiveIndex([
      { deviceKey: 'colon', mac: '02:AA:BB:CC:DD:EE' },
      { deviceKey: 'hyphen', mac: '02-aa-bb-11-22-33' },
      { deviceKey: 'other', mac: '02:AA:BC:CC:DD:EE' },
    ]);
    assert.deepEqual(keys(index.search('02aabb')), ['colon', 'hyphen']);
    assert.deepEqual(keys(index.search('AA:BB')), ['colon', 'hyphen']);
    assert.deepEqual(keys(index.search('02AABBCCDDEE')), ['colon']);
  });
  test('MAC-like queries never fuzzy-match a different address or name', () => {
    const index = createArchiveIndex([
      { deviceKey: 'mac', mac: '02:ab:cd:ef:00:40' },
      { deviceKey: 'name', hostname: '02:ab:cd:ef:00:42' },
      { deviceKey: 'compact-name', hostname: 'aabbccddeefa' },
    ]);
    for (const query of ['02:ab:cd:ef:00:41', '02abcdef0041', 'aabbccddeeff', '0041']) assert.deepEqual(index.search(query), []);
  });
  test('short alphabetic hex words remain ordinary fuzzy-searchable group names', () => {
    const index = createArchiveIndex([{ deviceKey: 'cafe', profile: { group: 'cafe' } }]);
    assert.deepEqual(keys(index.search('caff')), ['cafe']);
    assert.deepEqual(keys(index.search('CAFE')), ['cafe']);
  });
  test('distinct saved device keys sharing IP and MAC stay distinct', () => {
    const first = { deviceKey: 'old', ip: '192.0.2.45', mac: '02:00:00:00:00:45' };
    const second = { deviceKey: 'new', ip: '192.0.2.45', mac: '02:00:00:00:00:45' };
    const index = createArchiveIndex([first, second]);
    for (const query of ['', '192.0.2.45', '020000000045']) {
      assert.deepEqual(keys(index.search(query)), ['old', 'new']);
      assert.equal(index.search(query)[0], first);
      assert.equal(index.search(query)[1], second);
    }
  });
  test('hostile strings are searchable text without evaluation or input mutation', () => {
    const alias = '<img src=x onerror=globalThis.__archiveSearchExecuted=true>';
    const peer = Object.freeze({ deviceKey: 'hostile', profile: Object.freeze({ alias, group: '[$] (.*)' }) });
    const records = Object.freeze([peer]);
    const index = createArchiveIndex(records);
    assert.deepEqual(keys(index.search(alias)), ['hostile']);
    assert.deepEqual(keys(index.search('[$] (.*)')), ['hostile']);
    assert.equal(globalThis.__archiveSearchExecuted, undefined);
    assert.equal(peer.profile.alias, alias);
  });
  test('empty archives and records without optional fields are searchable', () => {
    assert.deepEqual(createArchiveIndex([]).search('anything'), []);
    assert.deepEqual(createArchiveIndex([{ deviceKey: 'bare' }]).search('anything'), []);
  });

  let passed = 0;
  for (const [name, body] of tests) { body(); passed++; console.log('PASS ' + name); }
  console.log('Pure saved-device archive search tests passed: ' + passed + '; no network operations.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
