const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-chord-arrays-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { normalizeChordArrays } = environment.load('services/chordData');
let server;
let baseUrl;
let user;
let token;

const chord = { name: 'C', root: 'C', frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0], baseFret: 1 };
const operation = (data, overrides = {}) => ({
  operationId: crypto.randomUUID(), entityId: crypto.randomUUID(), entityType: 'custom_chord',
  action: 'upsert', baseVersion: 0, data, ...overrides
});

async function request(url, body, method = 'POST', headers = {}) {
  const response = await fetch(baseUrl + url, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json(), collectionVersion: response.headers.get('X-Collection-Version') };
}
const sync = operations => request('/api/sync/v2', { deviceId: crypto.randomUUID(), operations });

test.before(async () => {
  user = await prisma.user.create({ data: { email: 'chord-arrays@example.test', passwordHash: 'unused' } });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  environment.cleanup();
});

const invalid = [
  { frets: 'not-json' }, { frets: '[1,' }, { frets: '{"value":1}' }, { frets: '"text"' }, { frets: 'null' },
  { frets: [true, 3, 2, 0, 1, 0] }, { frets: [null, 3, 2, 0, 1, 0] }, { frets: [[0], 3, 2, 0, 1, 0] },
  { frets: [-2, 3, 2, 0, 1, 0] }, { frets: [0.5, 3, 2, 0, 1, 0] },
  { frets: [0, 3, 2, 0, 1, 0, 0] }, { frets: '1,,2' }, { frets: '1,2,' },
  { fingers: '[0,true,2,0,1,0]' }, { fingers: [0, 6, 2, 0, 1, 0] }, { fingers: [0, -1, 2, 0, 1, 0] },
  { fingers: [0, 3] }, { fingers: [0, '3', 2, 0, 1, 0] },
  { barres: 'not-json' }, { barres: '{}' }, { barres: [null] }, { barres: [-1] },
  { barres: [{ fret: 1, fromString: 1, toString: 7 }] }, { barres: [{ fret: true, fromString: 1, toString: 6 }] },
  { barres: [{ fret: 1, fromString: 2, toString: 2 }] }, { barres: [{ value: 1 }] }
];

test('the array validator rejects undefined fields, sparse arrays and non-finite numeric values', () => {
  for (const fields of [
    { frets: undefined }, { fingers: undefined }, { barres: undefined },
    { frets: new Array(6) }, { barres: new Array(1) }, { frets: [NaN] },
    { frets: [Infinity] }, { frets: [2147483648] }, { frets: '[1e400]' }
  ]) {
    assert.throws(() => normalizeChordArrays(fields), error => error.status === 400 && error.details.code === 'validation_error');
  }
});

test('sync rejects malformed chord arrays without rows or change events', async () => {
  const before = await prisma.customChord.count();
  const events = await prisma.syncChange.count();
  const operations = invalid.map(fields => operation({ ...chord, ...fields }));
  const good = operation(chord);
  const result = await sync([...operations, good]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.acknowledgedOperationIds, [good.operationId]);
  assert.equal(result.body.rejectedOperations.length, operations.length);
  assert.ok(result.body.rejectedOperations.every(item => item.reason === 'validation_error'));
  assert.equal(await prisma.customChord.count(), before + 1);
  assert.equal(await prisma.syncChange.count(), events + 1);
});

test('legacy collection rejection preserves omitted chords, versions, snapshots and events', async () => {
  const created = [operation(chord), operation({ ...chord, name: 'Other' })];
  assert.equal((await sync(created)).body.rejectedOperations.length, 0);
  const current = await request('/api/chords', undefined, 'GET');
  const before = await prisma.customChord.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
  const events = await prisma.syncChange.count();
  for (const fields of invalid) {
    const result = await request('/api/chords/sync', [
      { ...current.body.find(item => item.id === created[0].entityId), name: 'Would change' },
      { id: crypto.randomUUID(), ...chord, ...fields }
    ], 'POST', { 'X-Collection-Version': current.collectionVersion });
    assert.equal(result.status, 400, JSON.stringify(fields));
    assert.equal(result.body.code, 'validation_error');
    assert.deepEqual(await prisma.customChord.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } }), before);
    assert.equal(await prisma.syncChange.count(), events);
  }
});

test('array, JSON and legacy CSV chord fields persist as parseable canonical JSON', async () => {
  for (const form of [
    { frets: chord.frets, fingers: chord.fingers, barres: [] },
    { frets: JSON.stringify(chord.frets), fingers: JSON.stringify(chord.fingers), barres: '[1]' },
    { frets: ' -1, 3, 2, 0, 1, 0 ', fingers: '0,3,2,0,1,0', barres: null }
  ]) {
    const item = operation({ ...chord, ...form });
    const result = await sync([item]);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.acknowledgedOperationIds, [item.operationId]);
    const row = await prisma.customChord.findUnique({ where: { id: item.entityId } });
    assert.deepEqual(JSON.parse(row.frets), chord.frets);
    assert.deepEqual(JSON.parse(row.fingers), chord.fingers);
    const snapshot = JSON.parse((await prisma.syncChange.findFirst({ where: { entityId: item.entityId } })).payload);
    assert.deepEqual(JSON.parse(snapshot.data.frets), chord.frets);
    assert.deepEqual(JSON.parse(snapshot.data.fingers), chord.fingers);
    if (form.barres === null) assert.equal(row.barres, null);
    else assert.ok(Array.isArray(JSON.parse(row.barres)));
  }
});

test('legacy CSV writes and subsequent GET-to-POST round trips remain compatible', async () => {
  const current = await request('/api/chords', undefined, 'GET');
  const id = crypto.randomUUID();
  const item = { id, ...chord, frets: '-1,3,2,0,1,0', fingers: '0,3,2,0,1,0', barres: '[1]' };
  const result = await request('/api/chords/sync', [...current.body, item], 'POST', {
    'X-Collection-Version': current.collectionVersion
  });
  assert.equal(result.status, 200);
  const row = await prisma.customChord.findUnique({ where: { id } });
  assert.deepEqual(JSON.parse(row.frets), chord.frets);
  assert.deepEqual(JSON.parse(row.fingers), chord.fingers);
  const next = await request('/api/chords', undefined, 'GET');
  assert.equal((await request('/api/chords/sync', next.body, 'POST', {
    'X-Collection-Version': next.collectionVersion
  })).status, 200);
});

test('partial edits validate array length against the stored counterpart and preserve unchanged fields', async () => {
  const created = operation(chord);
  assert.equal((await sync([created])).body.rejectedOperations.length, 0);
  const before = await prisma.customChord.findUnique({ where: { id: created.entityId } });
  const events = await prisma.syncChange.count();
  for (const fields of [{ fingers: [0] }, { frets: [0] }, { frets: 'bad-json' }]) {
    const result = await sync([operation(fields, { entityId: created.entityId, baseVersion: 1 })]);
    assert.equal(result.body.rejectedOperations[0].reason, 'validation_error');
    assert.deepEqual(await prisma.customChord.findUnique({ where: { id: created.entityId } }), before);
    assert.equal(await prisma.syncChange.count(), events);
  }
  const rename = await sync([operation({ name: 'Renamed' }, { entityId: created.entityId, baseVersion: 1 })]);
  assert.equal(rename.body.rejectedOperations.length, 0);
  const row = await prisma.customChord.findUnique({ where: { id: created.entityId } });
  assert.equal(row.frets, before.frets);
  assert.equal(row.fingers, before.fingers);
  assert.equal(row.version, 2);
});

test('unknown fingerings and supported barre representations remain compatible', async () => {
  for (const fields of [
    { fingers: [] }, { fingers: [0, 5, 2, 0, 1, 0] }, { frets: '0', fingers: '0' },
    { barres: [{ fret: 1, fromString: 6, toString: 1 }] },
    { barres: [1, 3] }
  ]) {
    const result = await sync([operation({ ...chord, ...fields })]);
    assert.equal(result.status, 200);
    assert.equal(result.body.rejectedOperations.length, 0);
  }
});

test('editing a valid historical CSV chord normalizes its representation without losing metadata', async () => {
  const original = await prisma.customChord.create({ data: {
    id: crypto.randomUUID(), userId: user.id, ...chord,
    frets: '-1, 3, 2, 0, 1, 0', fingers: '0,3,2,0,1,0', barres: 'null',
    createdAt: 1n, updatedAt: 1n
  } });
  const result = await sync([operation({ name: 'Repaired representation' }, { entityId: original.id, baseVersion: 1 })]);
  assert.equal(result.status, 200);
  assert.equal(result.body.rejectedOperations.length, 0);
  const row = await prisma.customChord.findUnique({ where: { id: original.id } });
  assert.deepEqual(JSON.parse(row.frets), chord.frets);
  assert.deepEqual(JSON.parse(row.fingers), chord.fingers);
  assert.equal(row.barres, null);
  assert.equal(row.root, original.root);
  assert.equal(row.baseFret, original.baseFret);
  assert.equal(row.createdAt, original.createdAt);
  assert.equal(row.version, 2);
});

test('an invalid historical chord must be corrected before a partial edit can create a new snapshot', async () => {
  const original = await prisma.customChord.create({ data: {
    id: crypto.randomUUID(), userId: user.id, ...chord,
    frets: 'broken historical data', fingers: JSON.stringify(chord.fingers),
    createdAt: 1n, updatedAt: 1n
  } });
  const events = await prisma.syncChange.count();
  const result = await sync([operation({ name: 'Would rename' }, { entityId: original.id, baseVersion: 1 })]);
  assert.equal(result.status, 200);
  assert.equal(result.body.rejectedOperations[0].reason, 'validation_error');
  assert.deepEqual(await prisma.customChord.findUnique({ where: { id: original.id } }), original);
  assert.equal(await prisma.syncChange.count(), events);
  const repaired = await sync([operation({ frets: chord.frets }, { entityId: original.id, baseVersion: 1 })]);
  assert.equal(repaired.body.rejectedOperations.length, 0);
  assert.deepEqual(JSON.parse((await prisma.customChord.findUnique({ where: { id: original.id } })).frets), chord.frets);
});

test('rejected chord operations stay idempotent and a corrected payload requires a new operation ID', async () => {
  const deviceId = crypto.randomUUID();
  const bad = operation({ ...chord, frets: 'malformed' });
  const first = await request('/api/sync/v2', { deviceId, operations: [bad] });
  assert.equal(first.body.rejectedOperations[0].reason, 'validation_error');
  const retry = await request('/api/sync/v2', { deviceId, operations: [{ ...bad, data: chord }] });
  assert.equal(retry.body.rejectedOperations[0].reason, 'validation_error');
  assert.equal(await prisma.customChord.count({ where: { id: bad.entityId } }), 0);
  const fixed = await request('/api/sync/v2', { deviceId, operations: [operation(chord, { entityId: bad.entityId })] });
  assert.equal(fixed.body.rejectedOperations.length, 0);
  assert.equal(await prisma.customChord.count({ where: { id: bad.entityId } }), 1);
});
