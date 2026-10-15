# IPFS reliability composition candidate

This branch composes four existing fixes onto
`9652573ca6c8c076edb784561f7ddfb70d8956de`:

| Component | Exact source | Retained behavior |
| --- | --- | --- |
| PR7 | `4a17387ecc73878e39c7345f2437803c2353fc15` | Independent raw-input and serialized-envelope 10 MiB upload caps |
| PR10 | `8fac3c4dc15cd711772cef15c701c5ce89d9bdfd` | Existing 12-second gateway deadline remains active through body consumption |
| PR16 | `9903d26b60092de3bf52dce748dced8db4907f63` | Bounded streaming reads, final oversize refusal, malformed-JSON fallback and whole-token configuration parsing |
| PR18 | `8b7aa67ea6ac9458cf68ef513825b0c453f1b5c8` | Base64 admission before recipient resolution, encryption or storage |

PR16 already includes PR14 (`4b3c029e058736c57813dfbc4fc95ef1eb988b9f`).
PR14 is not applied again. Original authorship and individual fix credit remain
with their component contributions.

The actual Git conflict was in `src/ipfs/gateway.ts`. Its resolution retains
PR16's bounded read and final typed oversize error, and places the bounded read
**and decode** inside PR10's consume callback. The callback settles before the
existing timeout's `finally` clears it. This avoids choosing either branch's
gateway wholesale and losing the other behavior. `src/tools/upload_content.ts`
merged automatically: PR18 admission still occurs before every side-effect
seam; PR7 checks serialized bytes independently before storage. All other
component files carry their pinned component bytes unchanged.

## Qualification

Using Node 24.21, install the exact locked graph with lifecycle scripts disabled:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/typescript/bin/tsc
node scripts/test-ipfs-composition.mjs results.json
```

The complete composition suite has 63 cases. It runs the actual compiled
gateway, upload and config modules with fake HTTP streams, virtual timers,
storage and inert ciphertext/recipient-resolution replacements. Module hooks
refuse wallet, actual encryption/key generation, signing, gRPC, financial tools
and network transports. No application server is started. Configuration uses
an explicit non-wallet sentinel environment, so no operator seed/cache file is
read. No provider, account or ledger is contacted.

One initial oracle expectation was corrected transparently: `YQ=` is accepted
by PR18's explicitly documented re-padding rule and preserves the byte `a`.
The initial run was 62/63; the corrected contract run is 63/63. The source
decoder was not changed. This is not a new defect claim.

**Decision: GO-with-conditions for maintainer integration review.** The complete
synthetic composition suite and static TypeScript build pass. The original full
financial and real-encryption suite was not run because it exceeds the owner's
execution scope. Maintainers must obtain that coverage in their authorized
environment before release. This branch does not establish deployment,
upstream adoption, main merge, real cryptographic correctness or live provider
compatibility. Component tests are retained as source, not represented as
executed here. Package and lock files, crypto, keys, submitter and server
registration remain unchanged.
