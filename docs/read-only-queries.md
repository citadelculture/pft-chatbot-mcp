# Read-only DEX and NFT query contract

The seven query tools use a separate HTTP public-read transport. They preserve exact native amount strings and issued-currency identity/value fields. The transaction tools and their shared amount-building helpers are unchanged.

## Amounts and AMM identity

Native displays use integer arithmetic and six fractional digits: `9007199254740993` atoms displays as `9007199254.740993`. Original atom strings remain available. Issued amounts preserve `currency`, `issuer` and their original decimal string.

AMM reserves are associated with the requested assets by currency/issuer identity before the labeled price is calculated. Either response slot can contain either requested asset. Unknown or duplicate reserve identities fail. The existing approximate eight-decimal ratio is retained; exact reserve strings are returned.

## Bounded pages

`dex_get_balances`, `dex_get_open_orders`, `nft_get_owned` and `nft_get_offers` return at most `limit` records, plus `marker`, `complete`, `ledger_hash`, `ledger_index` and `snapshot_pinned`. Balances returns a page of trust lines; orders returns a page across trading pairs. Follow `marker` until it is null for the complete query scope.

Pass each returned marker unchanged to the same query/account/NFT. Markers retain opaque server continuation, an offset when a server page exceeds the requested record count, and available closed-ledger identity. This also supports server markers that are objects. Old raw string server markers remain accepted. Partial pages are re-read at the same ledger and checked for changes before their remainder is returned. A wrong-scope, malformed, stale or changed-ledger marker fails; restart without a marker to begin a new snapshot.

When an upstream response omits closed-ledger identity, `snapshot_pinned` is false. This reports the limitation explicitly. Partial-page fingerprints still detect changed content; they do not turn an unpinned multi-page query into a fixed snapshot. The native balance is requested at the trust-line page's ledger when available, and returned ledger identity is checked.

`account_nfts` limits token pages, with up to32NFTs per page, rather than individual NFT records. The tool's `limit` is a record bound: it slices the returned page and retains its unscanned remainder in the continuation position.

## NFT offers and holdings scans

Only the exact structured `objectNotFound` RPC code means an NFT has no sell offers. HTTP failures, malformed JSON/results and availability errors propagate as tool errors. A generic message containing “not found” is insufficient. An empty offer page that still has continuation is incomplete; the listings scan fails instead of claiming absence. `nft_get_offers` exposes the continuation directly.

`nft_get_listings` scans NFTs **currently held by `account`**. It does not enumerate all NFTs minted by an issuer and held elsewhere. The old `issuer` input/output remains a deprecated alias for the queried account; conflicting aliases fail. The output states `scope: account_holdings`.

The scan returns at most `limit` held NFTs per call. `complete`/`complete_scope: account_holdings_scan` describe that holdings scan. Each listing includes its returned `sell_offers`, `offers_marker` and `offers_complete`; the top-level `offers_complete` describes the offer pages for the scanned NFTs. Continue a listing's offer page through `nft_get_offers` using its `nft_id` and `offers_marker`.

`best_*` selects the lowest native amount among the returned native offers, using exact integer comparison. `best_price_scope: returned_native_offers` makes that bound explicit. Issued-only offers retain their full amounts; native best-price fields are null. Different currencies and unseen offer pages are not treated as a single comparable price set.

## Validation and scope

With Node24.21 and the committed dependency lock:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node scripts/test-readonly-queries.mjs
```

The native runner evaluates the actual compiled query modules with strict fake HTTP/metadata fixtures and real-socket traps. A module hook rejects wallet/key/transaction imports. `--baseline` is an evidence mode for the original PR1 source: it supplies only that source's exact compiled `rpcCall` function, without the wallet-importing module initializer. The normal patched mode imports the actual pure read transport. No full server startup, wallet, key derivation, financial mutation, real provider/account or ledger execution is part of this validation. The regression runner uses Node24's module hooks; application engine requirements are unchanged.

AI-assisted implementation and regression harness. The author's original feature and earlier paid discovery/review are excluded from this repair's contribution credit.

Primary contracts: [AMM reserve slots](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info), [NFT sell offers and absence code](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/nft_sell_offers), [account-owned NFT pages](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_nfts), [trust-line pages](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines), [account order pages](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_offers).
