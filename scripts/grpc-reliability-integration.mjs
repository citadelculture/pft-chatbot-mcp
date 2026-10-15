import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const clientModule = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("../dist/grpc/client.js", import.meta.url);
const { KeystoneClient } = await import(clientModule.href);

// Offline integration only. Bypass the constructor and populate synthetic stubs;
// no real channel, provider, account, API key, wallet, signing or send module.
const cases = [];
const originalNow = Date.now;
const originalTimer = globalThis.setTimeout;
const originalDeadline = process.env.KEYSTONE_GRPC_DEADLINE_MS;
const originalWrite = process.stderr.write;
let clock, delays, events;
function reset() {
  clock = 100_000; delays = []; events = [];
  Date.now = () => clock;
  globalThis.setTimeout = (callback, ms, ...args) => {
    delays.push(ms); clock += ms; queueMicrotask(() => callback(...args));
    return { unref() {} };
  };
  process.stderr.write = () => true;
  process.env.KEYSTONE_GRPC_DEADLINE_MS = "1250";
}
const transient = (code = grpc.status.DEADLINE_EXCEEDED) => Object.assign(new Error("synthetic transient"), { code });
function clientFor(outcomes, { attempts = 3, threshold = 2 } = {}) {
  const client = Object.create(KeystoneClient.prototype);
  let generation = -1;
  const method = function (request, metadata, options, callback) {
    assert.equal(this.generation, generation, "must re-resolve the current channel stub");
    assert.equal(typeof callback, "function", "must use the four-argument overload");
    assert.ok(options.deadline instanceof Date);
    events.push({ request, metadata, deadline: options.deadline, now: clock, generation, method: this.method });
    const next = outcomes.shift();
    assert.ok(next, "unexpected extra attempt");
    clock += 20; // Controlled processing time in addition to controlled backoff.
    queueMicrotask(() => callback(next.error ?? null, next.result));
  };
  const buildServices = () => {
    generation++;
    for (const service of ["agentRegistry", "contentStorage", "envelopeStorage", "authService"]) {
      const stub = { generation, close() {} };
      for (const name of ["pingAgent", "storeEnvelope", "deleteAgentCard", "verifyAndIssueKey"]) stub[name] = method;
      client[service] = stub;
    }
  };
  Object.assign(client, { apiKey: null, retryPolicy: { maxAttempts: attempts, baseDelayMs: 50, maxDelayMs: 80 }, recreateAfter: threshold, consecutiveTransientFailures: 0, buildServices });
  buildServices();
  return { client, generation: () => generation };
}
async function test(name, run) {
  reset();
  try { await run(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error.message }); }
}
function assertDeadlines(duration) {
  for (const event of events) assert.equal(event.deadline.getTime(), event.now + duration);
  if (events.length > 1) assert.notEqual(events[0].deadline, events[1].deadline);
}
try {
  await test("retried-read-fresh-deadlines-and-channel-reresolution", async () => {
    const { client, generation } = clientFor([{ error: transient() }, { error: transient() }, { result: { synthetic: "ok" } }]);
    const request = Object.freeze({ fixture: "only" });
    const metadata = new grpc.Metadata(); metadata.set("x-integration-fixture", "synthetic");
    const result = await client.unary("agentRegistry", "pingAgent", request, metadata);
    assert.deepEqual(result, { synthetic: "ok" }); assert.equal(events.length, 3);
    assert.deepEqual(delays, [50, 80]); assert.deepEqual(events.map((event) => event.generation), [0, 0, 1]);
    assert.equal(generation(), 1); assert.equal(client.transientFailureStreak, 0);
    for (const event of events) { assert.equal(event.request, request); assert.equal(event.metadata, metadata); }
    assert.deepEqual(events.map((event) => event.now), [100000, 100070, 100170]); assertDeadlines(1250);
  });
  await test("terminal-deadline-counts-and-rebuilds-once", async () => {
    const { client, generation } = clientFor(Array.from({ length: 3 }, () => ({ error: transient() })), { threshold: 3 });
    await assert.rejects(client.pingAgent(), { code: grpc.status.DEADLINE_EXCEEDED });
    assert.equal(events.length, 3); assert.equal(generation(), 1); assert.equal(client.transientFailureStreak, 0);
    assert.deepEqual(delays, [50, 80]); assertDeadlines(1250);
  });
  await test("non-idempotent-deadline-failures-count-without-retry", async () => {
    const { client, generation } = clientFor(Array.from({ length: 3 }, () => ({ error: transient() })), { threshold: 3 });
    for (const [index, [service, method]] of [["envelopeStorage", "storeEnvelope"], ["agentRegistry", "deleteAgentCard"], ["authService", "verifyAndIssueKey"]].entries()) {
      await assert.rejects(client.unary(service, method, { fixture: "synthetic-only" }), { code: grpc.status.DEADLINE_EXCEEDED });
      assert.equal(events.length, index + 1); assert.equal(client.transientFailureStreak, index === 2 ? 0 : index + 1);
    }
    assert.equal(generation(), 1); assert.deepEqual(delays, []); assertDeadlines(1250);
  });
  await test("success-resets-streak-between-deadline-failures", async () => {
    const { client, generation } = clientFor([{ error: transient() }, { result: {} }, { error: transient() }], { attempts: 1, threshold: 2 });
    await assert.rejects(client.pingAgent(), { code: grpc.status.DEADLINE_EXCEEDED });
    assert.equal(client.transientFailureStreak, 1); await client.pingAgent(); assert.equal(client.transientFailureStreak, 0);
    await assert.rejects(client.pingAgent(), { code: grpc.status.DEADLINE_EXCEEDED });
    assert.equal(client.transientFailureStreak, 1); assert.equal(generation(), 0); assert.deepEqual(delays, []); assertDeadlines(1250);
  });
  await test("permanent-error-keeps-one-deadline-without-rebuild", async () => {
    const { client, generation } = clientFor([{ error: transient(grpc.status.PERMISSION_DENIED) }], { threshold: 1 });
    await assert.rejects(client.pingAgent(), { code: grpc.status.PERMISSION_DENIED });
    assert.equal(events.length, 1); assert.equal(generation(), 0); assert.equal(client.transientFailureStreak, 0); assert.deepEqual(delays, []); assertDeadlines(1250);
  });
  await test("disabled-retry-still-has-deadline-and-terminal-rebuild", async () => {
    const { client, generation } = clientFor([{ error: transient() }], { attempts: 1, threshold: 1 });
    await assert.rejects(client.pingAgent(), { code: grpc.status.DEADLINE_EXCEEDED });
    assert.equal(events.length, 1); assert.equal(generation(), 1); assert.equal(client.transientFailureStreak, 0); assert.deepEqual(delays, []); assertDeadlines(1250);
  });
  for (const [setting, expected] of [[undefined, 30000], ["1", 1], ["300000", 300000]]) {
    await test(`deadline-setting-${String(setting)}`, async () => {
      if (setting === undefined) delete process.env.KEYSTONE_GRPC_DEADLINE_MS; else process.env.KEYSTONE_GRPC_DEADLINE_MS = setting;
      const { client } = clientFor([{ result: {} }]); await client.pingAgent(); assertDeadlines(expected);
    });
  }
  for (const setting of ["0", "300001", "1.5", "invalid"]) {
    await test(`invalid-deadline-before-fake-transport-${setting}`, async () => {
      process.env.KEYSTONE_GRPC_DEADLINE_MS = setting;
      const { client, generation } = clientFor([{ result: {} }]);
      await assert.rejects(client.pingAgent(), /KEYSTONE_GRPC_DEADLINE_MS/);
      assert.equal(events.length, 0); assert.deepEqual(delays, []); assert.equal(generation(), 0);
    });
  }
} finally {
  Date.now = originalNow; globalThis.setTimeout = originalTimer; process.stderr.write = originalWrite;
  if (originalDeadline === undefined) delete process.env.KEYSTONE_GRPC_DEADLINE_MS; else process.env.KEYSTONE_GRPC_DEADLINE_MS = originalDeadline;
}
console.log(JSON.stringify({ provenance: "Source-informed composed native-wrapper contract; controlled fake clock/backoff and synthetic stubs, no live channels or financial execution", runtime: process.version, passed: cases.filter((row) => row.passed).length, failed: cases.filter((row) => !row.passed).length, cases }, null, 2));
if (cases.some((row) => !row.passed)) process.exitCode = 1;
