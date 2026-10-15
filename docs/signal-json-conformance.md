# Passive signal codec JSON conformance

After the native ESM initializer repair, declared JSON payloads still failed
protobuf verification: enum names were passed directly to numeric enum fields,
and decimal uint64 strings were passed to fields requiring Long values.
Decoded timestamps also discarded their nanoseconds, including milliseconds.

The codec now converts declared fields before `verify`, including nested messages,
arrays and maps. Declared enum names and numeric values are admitted explicitly;
unknown values reject. Canonical decimal 64-bit strings, safe integer numbers and
existing Long instances convert without a Number precision round trip. Invalid
syntax, unsafe numbers and out-of-range values reject before protobuf conversion.
Decimal string fields remain strings; the codec does not calculate financial values.

The protobuf parser's camelCase names and proto snake_case aliases are supported,
including names containing digits. Two aliases with deeply equal input values
are accepted; different values reject rather than selecting one silently. Unknown
fields retain protobuf's ignored-field behavior and null retains its optional-field
behavior. These are explicit admission choices for review, not a schema change.

ISO timestamps use JavaScript Date parsing at millisecond precision. Decode uses
seconds plus whole milliseconds from nanos, including negative epochs and omitted
zero seconds. Only schema-declared timestamps are converted; metadata that happens
to contain `seconds` or `nanos` keys remains metadata. Sub-millisecond precision is
not represented by the returned ISO strings. This does not add Timestamp domain
validation beyond the existing protobuf structural checks.

Run `npm run test:signals-native` against built JavaScript. The tests import only
passive codec/protobuf modules and use synthetic data and independent reference
wire builders. They never import the MCP server, wallet, keys, providers, send
tools, ledger submission, DEX or NFT operations.

Validation provenance: the original 29-case source-informed contract was frozen
before its red run and prototype edits (11 pass / 18 fail), then passed 29/29.
A supplementary 39-case boundary matrix passed after correcting five reference
fixtures to explicitly include zero seconds for exact byte comparison; the first
run's five failures were zero-field presence mismatches, not semantic failures.
The earlier 24-case initializer regression passes as neighboring coverage. These
are source-informed tests, not a blind implementation challenge.

No proto, dependency lock, financial-tool or transport code changed. The full
Vitest suite was not run because it includes key-derivation/send paths outside
this passive validation. Structural conformance does not establish business
validation, live transport, financial execution, deployment, merge or adoption.

The original initializer-only commit remains pinned at
`49d0f106ffe6bf510c2ee516abd6b06d4c3a4e9c`; its narrower historical evidence
is separate from this unpaid follow-through. AI-assisted implementation and tests.
