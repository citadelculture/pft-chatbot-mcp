import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import protobuf from "protobufjs";
import { decodeFinancialSignal, encodeFinancialSignal, encodePayload } from "../dist/signals/codec.js";

// Only passive codec/protobuf modules are imported. Never load the MCP server,
// wallet, submitter, send tools, signing or a provider in this native regression.
const protoDirectory = fileURLToPath(new URL("../src/grpc/protos/", import.meta.url));
const reference = new protobuf.Root();
reference.resolvePath = (_origin, target) => target.startsWith("google/") ? target : resolve(protoDirectory, target);
await reference.load(["signal", "market", "trade", "portfolio"].map((name) => `${protoDirectory}pf/signals/v1/${name}.proto`));
const envelopeType = reference.lookupType("pf.signals.v1.AgentFinancialSignal");
const decimal = "9007199254740993.000001";
const fixtures = [
  { kind: "price_quote", type: "PriceQuote", payload: { pair: { baseAsset: "PFT", quoteAsset: "SYN" }, bidPrice: decimal }, field: "bidPrice" },
  { kind: "trade_intent", type: "TradeIntent", payload: { intentId: "synthetic-only", quantity: decimal, side: 1 }, field: "quantity" },
  { kind: "trade_confirmation", type: "TradeConfirmation", payload: { filledQuantity: decimal, feeDrops: "9007199254740993" }, field: "filledQuantity" },
  { kind: "position_update", type: "PositionUpdate", payload: { positions: [{ asset: "SYN", balance: decimal }] }, field: null },
  { kind: "risk_metric", type: "RiskMetric", payload: { sharpeRatio: decimal }, field: "sharpeRatio" },
  { kind: "reward_offer", type: null, payload: { amount: decimal, nested: { synthetic: true } }, field: "amount" },
  { kind: "policy_update", type: null, payload: { limit: decimal, enabled: false }, field: "limit" },
];

function foreignWire(fixture, createdAt = { seconds: 42, nanos: 0 }) {
  const index = fixtures.indexOf(fixture);
  const payload = fixture.type
    ? reference.lookupType(`pf.signals.v1.${fixture.type}`).encode(
      reference.lookupType(`pf.signals.v1.${fixture.type}`).fromObject(fixture.payload),
    ).finish()
    : Buffer.from(JSON.stringify(fixture.payload));
  const message = envelopeType.fromObject({
    signalId: `synthetic-${fixture.kind}`, senderAgentId: "synthetic-sender",
    recipientAgentId: "synthetic-recipient", kind: index + 1,
    contentKind: fixture.kind.toUpperCase(), createdAt, payload,
    correlationId: "synthetic-correlation", schemaVersion: 1, metadata: { fixture: "only" },
  });
  assert.equal(envelopeType.verify(message), null, "Independently built reference wire must verify");
  return Buffer.from(envelopeType.encode(message).finish());
}

async function decodeCase(fixture) {
  const result = await decodeFinancialSignal(foreignWire(fixture));
  assert.equal(result.kind, fixture.kind);
  assert.equal(result.content_kind, fixture.kind.toUpperCase());
  assert.equal(result.sender_agent_id, "synthetic-sender");
  assert.equal(result.recipient_agent_id, "synthetic-recipient");
  assert.equal(result.signal_id, `synthetic-${fixture.kind}`);
  assert.equal(result.correlation_id, "synthetic-correlation");
  assert.equal(result.schema_version, 1);
  assert.deepEqual(result.metadata, { fixture: "only" });
  assert.equal(result.created_at, "1970-01-01T00:00:42.000Z");
  if (fixture.field) assert.equal(result.payload[fixture.field], decimal);
  else assert.equal(result.payload.positions[0].balance, decimal);
  return { kind: fixture.kind, initializationSucceeded: true };
}

if (process.argv[2] === "--cold-kind") {
  const fixture = fixtures.find((row) => row.kind === process.argv[3]);
  assert.ok(fixture);
  console.log(JSON.stringify(await decodeCase(fixture)));
} else if (process.argv[2] === "--diagnostics") {
  const encodes = [];
  for (const fixture of fixtures) {
    try {
      const bytes = await encodeFinancialSignal(fixture.kind, fixture.payload, "synthetic-sender");
      encodes.push({ kind: fixture.kind, encoded: true, bytes: bytes.length });
    } catch (error) {
      encodes.push({ kind: fixture.kind, encoded: false, error: error.message });
    }
  }
  const timestamps = [];
  for (const [milliseconds, timestamp] of [[-1, { seconds: -1, nanos: 999_000_000 }], [123, { seconds: 0, nanos: 123_000_000 }]]) {
    try {
      const decoded = await decodeFinancialSignal(foreignWire(fixtures[0], timestamp));
      const expected = new Date(milliseconds).toISOString();
      timestamps.push({ milliseconds, expected, actual: decoded.created_at, preserved: decoded.created_at === expected });
    } catch (error) { timestamps.push({ milliseconds, error: error.message }); }
  }
  console.log(JSON.stringify({ scope: "Non-gating deeper semantic diagnostics; failures are limitations, not passes", encodes, timestamps }, null, 2));
} else {
  const cases = [];
  async function test(name, run) {
    try { await run(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: error.message }); }
  }
  for (const fixture of fixtures) {
    await test(`cold-native-${fixture.kind}`, async () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--cold-kind", fixture.kind], { encoding: "utf8", timeout: 15_000 });
      assert.equal(child.status, 0, child.stderr.slice(-1200));
      assert.equal(JSON.parse(child.stdout).initializationSucceeded, true);
    });
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const fixture of fixtures) await test(`reused-native-${pass}-${fixture.kind}`, () => decodeCase(fixture));
  }
  for (const fixture of fixtures.filter((row) => !row.type)) {
    await test(`standalone-json-${fixture.kind}`, async () => {
      const bytes = await encodePayload(fixture.kind, fixture.payload);
      assert.deepEqual(JSON.parse(Buffer.from(bytes).toString("utf8")), fixture.payload);
    });
  }
  await test("malformed-wire-reaches-decoder", async () => {
    await assert.rejects(decodeFinancialSignal(Buffer.from([0xff])), (error) => !error.message.includes("Root is not a constructor"));
  });
  console.log(JSON.stringify({
    runtime: process.version, provenance: "Source-informed native built-JS import/decoder regression with independently constructed wire; no send/signing/provider paths",
    scope: "Initialization and declared foreign-wire decode only; not whole-envelope encode or complete feature adoption",
    passed: cases.filter((row) => row.passed).length, failed: cases.filter((row) => !row.passed).length, cases,
  }, null, 2));
  if (cases.some((row) => !row.passed)) process.exitCode = 1;
}
