# Issue3 composed gRPC reliability candidate

This candidate composes master `9652573ca6c8c076edb784561f7ddfb70d8956de`,
PR6 deadline head `41bc54e083007de13fc7062d39426f806097cd3a`, and corrected
PR11 retry head `d9b3a6e5997343c36665879f85126983ee096555`. Original source
authorship remains in the merge ancestry; individual implementation/review
credit is excluded from this integration work.

The only merge conflict was an append in `.env.example`; retain the deadline
and all four retry/recreation settings. The production client source composed
without a conflict. Existing deadline tests failed twice because their fixture
bypassed construction and omitted the newly composed retry state, so their
50ms observation race returned pending during retry backoff. Initialize that
fixture with a one-attempt policy to retain its deadline-only assertions.
This is a fixture integration repair, not evidence of a production defect.

The new native built-JS matrix exercises the actual composed unary wrapper
with a controlled clock, processing time, backoff, metadata and fake stubs:
13/13 cases pass. It bypasses construction and never opens real channels.
The focused existing suites improve from23 pass/2 fixture failures to25/25.
Four isolated compiled-wrapper faults (missing/stale deadline, retrying
non-idempotent operations, skipped terminal accounting) are all detected.
Build and TypeScript lint pass. Run `npm run test:grpc-integration`.

The configured deadline applies to each attempt, not the whole operation.
The default three30-second attempts plus250ms/500ms backoff can consume
about90.75seconds before other overhead. This does not provide a global
30-second request budget, jitter, live outage availability proof or an
idempotency guarantee for a remote service implementation.

Decision: suitable for maintainer review as an offline composed candidate;
NO-GO for claiming production release/adoption from this evidence alone.
Maintainers must choose the per-attempt timeout/retry/idempotency policy
and validate it on the deployed transport. No upstream branch, merge or
deployment is changed by this isolated candidate.

Tests import only the built gRPC wrapper/retry helper and synthetic stubs.
No MCP server, keys, signing, send tools, provider connection, real account
or ledger operation is executed. Full Vitest is excluded because unrelated
tests exercise key derivation/send paths. Expectations are source-informed,
not blind. AI-assisted integration and tests.
