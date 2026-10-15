import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { encodeFinancialSignal, decodeFinancialSignal } from "../dist/signals/codec.js";

// Passive local data conversion only: no MCP server, wallet, signing, send,
// provider or account modules. This is unpaid follow-through, not task evidence.
const directory = fileURLToPath(new URL("../src/grpc/protos/", import.meta.url));
const reference = new protobuf.Root();
reference.resolvePath = (_origin, target) => target.startsWith("google/") ? target : resolve(directory, target);
await reference.load(["signal", "market", "trade", "portfolio"].map((name) => resolve(directory, `pf/signals/v1/${name}.proto`)));
const Envelope = reference.lookupType("pf.signals.v1.AgentFinancialSignal");
const decimal = "9007199254740993.000001";
const fixtures = [
  { kind: "price_quote", type: "PriceQuote", payload: { bidPrice: decimal, pair: { baseAsset: "PFT", quoteAsset: "SYN" } } },
  { kind: "trade_intent", type: "TradeIntent", payload: { quantity: decimal, side: "TRADE_SIDE_BUY", orderType: "TRADE_ORDER_TYPE_LIMIT" } },
  { kind: "trade_confirmation", type: "TradeConfirmation", payload: { filledQuantity: decimal, feeDrops: "18446744073709551615", status: "TRADE_STATUS_FILLED" } },
  { kind: "position_update", type: "PositionUpdate", payload: { positions: [{ asset: "SYN", balance: decimal, valueInPft: decimal }], totalValuePft: decimal } },
  { kind: "risk_metric", type: "RiskMetric", payload: { sharpeRatio: decimal, overallLevel: "RISK_LEVEL_LOW" } },
  { kind: "reward_offer", type: null, payload: { amount: decimal, nested: { synthetic: true } } },
  { kind: "policy_update", type: null, payload: { limit: decimal, enabled: false } },
];
const options = { recipientAgentId: "synthetic-recipient", correlationId: "synthetic-correlation", metadata: { fixture: "only" }, expiresAt: "1970-01-01T00:00:00.123Z" };

function referencePayload(fixture, payload = fixture.payload) {
  if (!fixture.type) return Buffer.from(JSON.stringify(payload));
  const type = reference.lookupType(`pf.signals.v1.${fixture.type}`);
  const message = type.fromObject(payload);
  assert.equal(type.verify(message), null);
  return Buffer.from(type.encode(message).finish());
}

async function encoded(fixture, input = fixture.payload, expected = fixture.payload) {
  const bytes = await encodeFinancialSignal(fixture.kind, input, "synthetic-sender", options);
  const wire = Envelope.decode(bytes);
  assert.equal(Envelope.verify(wire), null);
  assert.equal(wire.senderAgentId, "synthetic-sender");
  assert.equal(wire.recipientAgentId, options.recipientAgentId);
  assert.equal(wire.correlationId, options.correlationId);
  assert.deepEqual(wire.metadata, options.metadata);
  assert.equal(wire.kind, fixtures.indexOf(fixture) + 1);
  assert.equal(wire.contentKind, reference.lookupEnum("pf.common.v4.ContentKind").values[fixture.kind.toUpperCase()]);
  assert.equal(wire.schemaVersion, 1);
  assert.equal(typeof wire.signalId, "string");
  assert.ok(wire.signalId.length > 0);
  assert.deepEqual(Buffer.from(wire.payload), referencePayload(fixture, expected));
  const decoded = await decodeFinancialSignal(bytes);
  assert.equal(decoded.expires_at, options.expiresAt);
  return { wire, decoded };
}

function foreignTimestamp(milliseconds, nested) {
  const timestamp = { seconds: Math.floor(milliseconds / 1000), nanos: ((milliseconds % 1000) + 1000) % 1000 * 1_000_000 };
  const payload = referencePayload(fixtures[0], nested ? { bidPrice: decimal, quotedAt: timestamp } : fixtures[0].payload);
  return Buffer.from(Envelope.encode(Envelope.fromObject({ kind: 1, contentKind: "PRICE_QUOTE", createdAt: timestamp, payload, schemaVersion: 1 })).finish());
}

const cases = [];
async function test(name, run) {
  try { await run(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error.message }); }
}
for (const fixture of fixtures) await test(`declared-json-${fixture.kind}`, () => encoded(fixture));
for (const feeDrops of ["0", "9007199254740993", "18446744073709551615"]) {
  await test(`uint64-exact-${feeDrops}`, () => encoded(fixtures[2], { feeDrops }, { feeDrops }));
}
for (const [name, feeDrops] of [
  ["negative", "-1"], ["overflow", "18446744073709551616"], ["fraction", "1.5"],
  ["exponent", "1e3"], ["unsafe-number", 9007199254740992], ["boolean", true], ["partial", "12tail"],
]) {
  await test(`uint64-reject-${name}`, () => assert.rejects(encodeFinancialSignal("trade_confirmation", { feeDrops }, "synthetic-sender")));
}
for (const side of ["UNKNOWN_SIDE", 99, -1]) {
  await test(`enum-reject-${String(side)}`, () => assert.rejects(encodeFinancialSignal("trade_intent", { side }, "synthetic-sender")));
}
await test("proto-field-alias-preserves-data", () => encoded(fixtures[0], { bid_price: decimal, pair: { base_asset: "PFT", quote_asset: "SYN" } }));
await test("conflicting-alias-rejects", () => assert.rejects(encodeFinancialSignal("price_quote", { bidPrice: "1", bid_price: "2" }, "synthetic-sender")));
for (const milliseconds of [-1, 123]) {
  for (const nested of [false, true]) {
    await test(`foreign-timestamp-${milliseconds}-${nested ? "nested" : "envelope"}`, async () => {
      const decoded = await decodeFinancialSignal(foreignTimestamp(milliseconds, nested));
      assert.equal(nested ? decoded.payload.quotedAt : decoded.created_at, new Date(milliseconds).toISOString());
    });
  }
}
for (const field of ["quoted_at", "quotedAt"]) {
  await test(`iso-payload-${field}`, () => encoded(fixtures[0], { bidPrice: decimal, [field]: "1969-12-31T23:59:59.999Z" }, { bidPrice: decimal, quotedAt: { seconds: -1, nanos: 999_000_000 } }));
}
await test("optional-envelope-defaults", async () => {
  const bytes = await encodeFinancialSignal("reward_offer", { amount: decimal }, "synthetic-sender");
  const decoded = await decodeFinancialSignal(bytes);
  assert.equal(decoded.recipient_agent_id, "");
  assert.equal(decoded.correlation_id, "");
  assert.deepEqual(decoded.metadata, {});
  assert.equal(decoded.payload.amount, decimal);
});
console.log(JSON.stringify({
  provenance: "New source-informed declared-wire/JSON prototype contract; no prior test credit or financial execution",
  runtime: process.version, passed: cases.filter((row) => row.passed).length, failed: cases.filter((row) => !row.passed).length, cases,
}, null, 2));
if (cases.some((row) => !row.passed)) process.exitCode = 1;
