// Native compiled-module qualification. No server, provider, wallet or crypto execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
const allowedApp = new Set(['dist/ipfs/gateway.js', 'dist/config.js', 'dist/tools/upload_content.js']);
const audit = { applicationModules: [], inertReplacements: [], boundaryViolations: [] };
const violation = (what) => { audit.boundaryViolations.push(what); throw new Error(`FORBIDDEN: ${what}`); };
const seams = { encrypt: null, resolve: null };
globalThis.__ipfsCompositionSeams = seams;
const inertModule = (name) => `data:text/javascript,${encodeURIComponent(name === 'encrypt'
  ? 'export const encryptBinaryForRecipients = (...args) => globalThis.__ipfsCompositionSeams.encrypt(...args);'
  : 'export const resolveRecipientKey = (...args) => globalThis.__ipfsCompositionSeams.resolve(...args);')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (/^(?:node:)?(?:net|tls|dgram|http|https|http2|crypto|child_process)$/.test(specifier) || /^(?:xrpl|libsodium|@grpc)/.test(specifier)) violation(`module:${specifier}`);
    const resolved = next(specifier, context);
    if (resolved.url.startsWith(pathToFileURL(root + path.sep).href)) {
      const rel = path.relative(root, fileURLToPath(resolved.url)).split(path.sep).join('/');
      if (rel === 'dist/crypto/encrypt.js' || rel === 'dist/crypto/resolve_key.js') {
        audit.inertReplacements.push(rel);
        return { url: inertModule(rel.endsWith('/encrypt.js') ? 'encrypt' : 'resolve'), shortCircuit: true };
      }
      if (rel.startsWith('dist/')) {
        if (!allowedApp.has(rel)) violation(`application:${rel}`);
        audit.applicationModules.push(rel);
      } else if (!rel.startsWith('node_modules/zod/')) violation(`dependency:${rel}`);
    } else if (resolved.url.startsWith('file:')) violation('file outside qualification checkout');
    return resolved;
  },
});

const nativeTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
let timers = new Map(), sequence = 0, callLog = [], streamReads = 0, cancellations = 0;
let stores = [], resolves = [], encryptions = [], activeDuringRead = [], activeDuringDecode = [];
const timerDelays = [];
globalThis.setTimeout = (fn, ms) => { const id = ++sequence; timers.set(id, fn); timerDelays.push(ms); assert.equal(ms, 12000); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = () => violation('interval');
globalThis.clearInterval = () => violation('clearInterval');
globalThis.fetch = () => violation('unconfigured fetch');
const gateway = await import(pathToFileURL(path.join(root, 'dist/ipfs/gateway.js')).href);
const upload = await import(pathToFileURL(path.join(root, 'dist/tools/upload_content.js')).href);
const configModule = await import(pathToFileURL(path.join(root, 'dist/config.js')).href);
const CAP = 10 * 1024 * 1024, DEFAULT_BOUND = 16 * 1024 * 1024;
const config = (bound = 20) => ({ ipfsGatewayUrl: 'https://primary.invalid', ipfsMaxFetchBytes: bound, pftlRpcUrl: 'https://rpc.invalid' });
const CID = 'synthetic-cid';
const expectedUrls = ['https://primary.invalid/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://cloudflare-ipfs.com/ipfs/', 'https://ipfs.io/ipfs/'].map(x => x + CID);
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const tick = async () => { const batch = [...timers.entries()]; for (const [id, fn] of batch) { if (timers.delete(id)) fn(); } await drain(); };
const thrown = async (promise, pattern) => { await assert.rejects(promise, pattern); };
function respond({ chunks = [], declared = null, status = 200, hang = false, noBody = false } = {}, signal) {
  let index = 0;
  const reader = {
    async read() {
      streamReads++;
      activeDuringRead.push(timers.size);
      if (hang) return new Promise((_, reject) => {
        const abort = () => reject(new Error('synthetic body aborted'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      return index < chunks.length ? { done: false, value: Buffer.from(chunks[index++]) } : { done: true };
    },
    async cancel() { cancellations++; },
  };
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => name === 'content-length' ? declared : null },
    body: noBody ? null : { getReader: () => reader, cancel: async () => { cancellations++; } },
    async arrayBuffer() { activeDuringRead.push(timers.size); return Uint8Array.from(Buffer.concat(chunks.map(x => Buffer.from(x)))).buffer; },
  };
}
function network(plans) {
  globalThis.fetch = async (url, options) => {
    const slot = callLog.length;
    if (url !== expectedUrls[slot] || !options?.signal || Object.keys(options).some(k => k !== 'signal')) violation('unexpected request surface');
    callLog.push({ gateway: slot, timerActive: timers.size, aborted: false });
    options.signal.addEventListener('abort', () => { callLog[slot].aborted = true; }, { once: true });
    const plan = plans[slot];
    if (!plan) violation('unexpected fallback');
    if (plan.fetchError) throw new Error('synthetic fetch failed');
    return respond(plan, options.signal);
  };
}
function storage(envelope = { content_hash: 'synthetic-hash', payload: 'inert-ciphertext' }) {
  seams.resolve = async (...args) => { resolves.push(args); return 'inert-recipient-marker'; };
  seams.encrypt = async (bytes, recipients) => { encryptions.push({ bytes: Buffer.from(bytes), recipients }); return envelope; };
  return { async storeContent(bytes, mime) {
    stores.push({ bytes: Buffer.from(bytes), mime });
    return { descriptor: { uri: 'ipfs://synthetic-upload', contentType: mime, contentLength: BigInt(bytes.length), contentHash: new Uint8Array([1, 2]) } };
  } };
}
const keyMarker = { x25519PublicKey: 'inert-bot-marker' }; // Never a key; never passed to actual crypto.
const params = (content, more = {}) => ({ content, content_type: 'application/octet-stream', ...more });
const results = [];
async function test(id, body) {
  timers = new Map(); callLog = []; streamReads = 0; cancellations = 0;
  stores = []; resolves = []; encryptions = []; activeDuringRead = []; activeDuringDecode = []; timerDelays.length = 0;
  globalThis.fetch = () => violation('unconfigured fetch');
  let error = null;
  try { await body(); assert.equal(timers.size, 0, 'timer leak'); assert.equal(audit.boundaryViolations.length, 0, 'forbidden boundary'); }
  catch (err) { error = String(err.stack || err).replaceAll(root, '<checkout>').slice(0, 1200); }
  const row = { id, pass: error === null, error, fetches: callLog, streamReads, cancellations, activeDuringRead, activeDuringDecode, timerDelays: [...timerDelays], remainingTimers: timers.size, stores: stores.map(s => ({ bytes: s.bytes.length, mime: s.mime })), recipientCalls: resolves.length, inertCiphertextCalls: encryptions.length };
  results.push(row); console.log(`${row.pass ? 'PASS' : 'FAIL'} ${id}${error ? ': ' + error.split('\n')[0] : ''}`);
}

// Whole read boundary: caps, retry policy and deadline share the same native scope.
await test('bytes-exact-bound-split-stream', async () => {
  network([{ chunks: ['ab', 'cd'], declared: '4' }]);
  assert.equal((await gateway.fetchIpfsBytes(config(4), 'ipfs://' + CID)).toString(), 'abcd');
  assert.ok(activeDuringRead.every(n => n === 1)); assert.equal(callLog.length, 1);
});
await test('json-exact-bound-decode-under-deadline', async () => {
  network([{ chunks: ['{"a":', '1}'], declared: '7' }]);
  const nativeParse = JSON.parse;
  JSON.parse = (...args) => { activeDuringDecode.push(timers.size); return nativeParse(...args); };
  try { assert.deepEqual(await gateway.fetchIpfsJson(config(7), CID), { a: 1 }); } finally { JSON.parse = nativeParse; }
  assert.deepEqual(activeDuringDecode, [1]); assert.ok(activeDuringRead.every(n => n === 1));
});
for (const mode of ['bytes', 'json']) {
  const fetchBody = mode === 'bytes' ? gateway.fetchIpfsBytes : gateway.fetchIpfsJson;
  await test(`${mode}-declared-over-bound-final`, async () => {
    network([{ chunks: ['unused'], declared: '5' }]);
    await thrown(fetchBody(config(4), CID), gateway.IpfsContentTooLargeError);
    assert.equal(streamReads, 0); assert.equal(cancellations, 1); assert.equal(callLog.length, 1);
  });
  for (const declared of [null, '1']) await test(`${mode}-stream-over-bound-${declared === null ? 'missing-length' : 'dishonest-length'}`, async () => {
    network([{ chunks: ['abcd', 'e', 'never-read'], declared }]);
    await thrown(fetchBody(config(4), CID), gateway.IpfsContentTooLargeError);
    assert.equal(streamReads, 2); assert.equal(cancellations, 1); assert.equal(callLog.length, 1);
  });
  await test(`${mode}-hung-body-abort-then-bounded-fallback`, async () => {
    const good = mode === 'bytes' ? 'ok' : '{"ok":1}';
    network([{ hang: true }, { chunks: [good] }]);
    const pending = fetchBody(config(good.length), CID);
    await drain(); assert.equal(timers.size, 1); assert.equal(callLog.length, 1); await tick();
    const value = await pending;
    if (mode === 'bytes') assert.equal(value.toString(), good); else assert.deepEqual(value, { ok: 1 });
    assert.equal(callLog.length, 2); assert.equal(callLog[0].aborted, true); assert.equal(callLog[1].aborted, false);
    assert.equal(cancellations, 1); assert.ok(activeDuringRead.every(n => n === 1));
  });
  await test(`${mode}-all-bodies-timeout-and-cleanup`, async () => {
    network(Array.from({ length: 4 }, () => ({ hang: true })));
    const pending = fetchBody(config(), CID); const rejection = assert.rejects(pending, /all gateways/);
    for (let i = 0; i < 4; i++) { await drain(); assert.equal(timers.size, 1); await tick(); }
    await rejection; assert.equal(callLog.length, 4); assert.ok(callLog.every(x => x.aborted)); assert.equal(cancellations, 4);
  });
  await test(`${mode}-HTTP-then-network-failure-then-success`, async () => {
    network([{ status: 503 }, { fetchError: true }, { chunks: [mode === 'bytes' ? 'ok' : '{}'] }]);
    await fetchBody(config(), CID); assert.equal(callLog.length, 3); assert.ok(callLog.every(x => x.timerActive === 1 && !x.aborted));
  });
  await test(`${mode}-bodyless-adapter-boundary`, async () => {
    network([{ noBody: true, chunks: [mode === 'bytes' ? 'ab' : '{}'] }]);
    await fetchBody(config(2), CID); assert.deepEqual(activeDuringRead, [1]);
  });
  await test(`${mode}-bodyless-adapter-over-bound-final`, async () => {
    network([{ noBody: true, chunks: ['xxx'] }]);
    await thrown(fetchBody(config(2), CID), gateway.IpfsContentTooLargeError); assert.equal(callLog.length, 1);
  });
}
await test('malformed-json-fallback-with-cap-and-timer', async () => {
  network([{ chunks: ['bad'] }, { chunks: ['{}'] }]);
  assert.deepEqual(await gateway.fetchIpfsJson(config(3), CID), {}); assert.equal(callLog.length, 2);
  assert.ok(activeDuringRead.every(n => n === 1));
});
for (const bound of [undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  await test(`programmatic-invalid-bound-${String(bound)}-defaults`, async () => {
    network([{ declared: String(DEFAULT_BOUND + 1) }]);
    await assert.rejects(gateway.fetchIpfsBytes({ ...config(), ipfsMaxFetchBytes: bound }, CID), e => e instanceof gateway.IpfsContentTooLargeError && e.maxBytes === DEFAULT_BOUND);
    assert.equal(streamReads, 0); assert.equal(callLog.length, 1);
  });
}

// Upload admission ordering plus post-serialization cap, using inert envelope bytes.
for (const token of ['', ' ', 'A', '%%%not-base64', 'AA-_', 'YQ===', 'YQ==junk', 'YR==', 'A===', 'YQ==\u00a0']) {
  await test(`invalid-base64-refuses-before-all-seams-${JSON.stringify(token)}`, async () => {
    const client = storage(); await thrown(upload.executeUploadContent(config(), client, params(token, { encoding: 'base64', encrypt_for: 'synthetic-recipient' }), keyMarker), /not valid base64/);
    assert.equal(resolves.length + encryptions.length + stores.length, 0);
  });
}
for (const token of ['YQ==', 'YQ', 'YQ=', ' Y\tQ\r\n==\v\f', 'YWJj']) {
  await test(`valid-base64-byte-preservation-${JSON.stringify(token)}`, async () => {
    const client = storage(); const response = JSON.parse(await upload.executeUploadContent(config(), client, params(token, { encoding: 'base64' })));
    assert.equal(stores.length, 1); assert.ok(stores[0].bytes.equals(Buffer.from(token.replace(/\s/g, ''), 'base64'))); assert.equal(response.size, stores[0].bytes.length);
    assert.equal(resolves.length + encryptions.length, 0);
  });
}
await test('plaintext-exact-10MiB-and-MIME', async () => {
  const client = storage(); const out = JSON.parse(await upload.executeUploadContent(config(), client, params('x'.repeat(CAP), { content_type: 'text/plain' })));
  assert.equal(stores[0].bytes.length, CAP); assert.equal(stores[0].mime, 'text/plain'); assert.equal(out.size, CAP); assert.equal(out.content_hash, '0102'); assert.equal(resolves.length + encryptions.length, 0);
});
await test('raw-over-10MiB-refuses-before-encryption-and-store', async () => {
  const client = storage(); await thrown(upload.executeUploadContent(config(), client, params('x'.repeat(CAP + 1), { encrypt_for: 'synthetic-recipient' }), keyMarker), /Content too large/);
  assert.equal(resolves.length + encryptions.length + stores.length, 0);
});
for (const extra of [0, 1]) await test(`canonical-base64-post-envelope-${extra === 0 ? 'exact' : 'over'}-10MiB`, async () => {
  const envelope = { content_hash: 'synthetic-hash', payload: '' };
  envelope.payload = 'x'.repeat(CAP + extra - Buffer.byteLength(JSON.stringify(envelope)));
  assert.equal(Buffer.byteLength(JSON.stringify(envelope)), CAP + extra);
  const client = storage(envelope);
  const pending = upload.executeUploadContent(config(), client, params(' YQ==\n', { encoding: 'base64', encrypt_for: 'synthetic-recipient', content_type: 'text/plain' }), keyMarker);
  if (extra) { await thrown(pending, /Encrypted content too large/); assert.equal(stores.length, 0); }
  else { const out = JSON.parse(await pending); assert.equal(stores[0].bytes.length, CAP); assert.equal(stores[0].mime, 'application/json'); assert.equal(out.size, 1); assert.equal(out.encrypted, true); assert.equal(out.content_hash, 'synthetic-hash'); assert.equal(out.content_type, 'text/plain'); }
  assert.equal(resolves.length, 1); assert.equal(encryptions.length, 1); assert.equal(encryptions[0].bytes.toString(), 'a'); assert.deepEqual(encryptions[0].recipients, ['inert-bot-marker', 'inert-recipient-marker']);
});
await test('raw-cap-independent-of-small-inert-envelope', async () => {
  const client = storage({ content_hash: 'synthetic-hash', payload: '' });
  await thrown(upload.executeUploadContent(config(), client, params('x'.repeat(CAP + 1), { encrypt_for: 'synthetic-recipient' }), keyMarker), /Content too large/);
  assert.equal(resolves.length + encryptions.length + stores.length, 0);
});
await test('missing-key-marker-refuses-before-resolve', async () => {
  const client = storage(); await thrown(upload.executeUploadContent(config(), client, params('YQ==', { encoding: 'base64', encrypt_for: 'synthetic-recipient' })), /Bot keypair required/); assert.equal(resolves.length + encryptions.length + stores.length, 0);
});

// Exercise the actual config module with a wholly synthetic environment. No seed file/cache access.
const originalEnv = process.env;
const syntheticEnv = { BOT_SEED: 'NON_WALLET_SENTINEL_NOT_A_SEED', KEYSTONE_API_KEY: 'SYNTHETIC_NO_AUTH', TASKNODE_ENCRYPTION_PUBKEY: 'none' };
const configCases = [
  ['defaults', undefined, undefined, 900000, DEFAULT_BOUND], ['blank', ' ', '\t', 900000, DEFAULT_BOUND],
  ['zero-disables-ping', '0', '1', 0, 1], ['trimmed-decimals', ' 2000 ', ' 12 ', 2000, 12],
  ['ceilings', '2147483647', '9007199254740991', 2147483647, Number.MAX_SAFE_INTEGER],
  ['timer-overflow', '2147483648', '16777217', 900000, 16777217],
  ...['5e3', '15m', '0.5', '-1', 'Infinity', 'NaN', '9007199254740992', '+12', '0x10'].map((x, i) => [`invalid-token-${i}`, x, x, 900000, DEFAULT_BOUND]),
  ['ipfs-zero-refused', '1', '0', 1, DEFAULT_BOUND],
];
for (const [id, ping, bound, expectedPing, expectedBound] of configCases) await test(`config-${id}`, async () => {
  process.env = { ...syntheticEnv, ...(ping === undefined ? {} : { PING_INTERVAL_MS: ping }), ...(bound === undefined ? {} : { IPFS_MAX_FETCH_BYTES: bound }) };
  const warnings = []; const nativeWrite = process.stderr.write;
  process.stderr.write = (s) => { warnings.push(String(s)); return true; };
  let value; try { value = configModule.loadConfig(); } finally { process.env = originalEnv; process.stderr.write = nativeWrite; }
  assert.equal(value.pingIntervalMs, expectedPing); assert.equal(value.ipfsMaxFetchBytes, expectedBound);
  assert.equal(value.tasknodeEncryptionKey, null); assert.equal(value.botSeed, syntheticEnv.BOT_SEED);
  if (id.startsWith('invalid') || id === 'timer-overflow' || id === 'ipfs-zero-refused') assert.ok(warnings.length > 0);
});

Object.assign(globalThis, nativeTimers);
delete globalThis.__ipfsCompositionSeams;
const report = { schemaVersion: 1, scope: 'whole IPFS composition, synthetic interfaces only', node: process.version, cases: results.length, passed: results.filter(x => x.pass).length, failed: results.filter(x => !x.pass).length, audit: { ...audit, applicationModules: [...new Set(audit.applicationModules)], inertReplacements: [...new Set(audit.inertReplacements)] }, results, exclusions: ['Original full financial/real-encryption suite', 'Actual encryption/key generation/wallet/signing', 'Provider/account/ledger calls', 'Full server startup', 'Maintainer adoption or deployment claim'] };
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ cases: report.cases, passed: report.passed, failed: report.failed, boundaryViolations: audit.boundaryViolations.length }));
if (report.failed || audit.boundaryViolations.length) process.exitCode = 1;
