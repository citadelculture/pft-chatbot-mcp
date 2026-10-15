# Signal codec native ESM regression

Run `npm run test:signals-native` to compile the production JavaScript and test
it with the current native Node runtime. A TypeScript/Vitest transform can mask
the CommonJS namespace interoperability failure, so this check imports the
built codec directly.

The regression constructs independent valid protobuf envelopes for all seven
declared signal kinds. Each kind is decoded in a fresh process, then twice in
one process to exercise the reusable root. It checks identities, correlation,
kind, metadata, exact decimal strings, whole-second timestamps, standalone JSON
payloads and malformed-wire rejection. The normal `npm test` chain includes
this check after Vitest.

The script imports only the passive codec, protobuf library and Node builtins.
It does not import the MCP server, wallet, submitter or send tools, and does not
derive keys, sign, submit transactions, contact a provider or access an account.

This is an initialization repair, not proof of complete signal-feature
correctness. Run `node scripts/signals-native-esm-regression.mjs --diagnostics`
after building to inspect whole-envelope encode outcomes and independently
constructed fractional timestamps. These diagnostics report deeper semantic
gaps separately; their failures are not counted as regression passes. Schema,
wire format, dependency versions and unrelated financial tools are unchanged.
