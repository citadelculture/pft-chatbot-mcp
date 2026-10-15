/** Native fake-transport regressions. No wallet, real RPC or transaction execution. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as dgram from 'node:dgram';
import { registerHooks } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const outputAt = process.argv.indexOf('--output');
const output = outputAt < 0 ? null : process.argv[outputAt + 1];
const names = ['dex_get_balances', 'dex_get_order_book', 'dex_get_amm_info', 'dex_get_open_orders', 'nft_get_owned', 'nft_get_offers', 'nft_get_listings'];
const functions = ['DexGetBalances', 'DexGetOrderBook', 'DexGetAmmInfo', 'DexGetOpenOrders', 'NftGetOwned', 'NftGetOffers', 'NftGetListings'];
const allowed = new Set(['account_info', 'account_lines', 'book_offers', 'amm_info', 'account_offers', 'account_nfts', 'nft_sell_offers']);
const loaded = new Set();
const boundaryViolations = [];
const blocked = /(?:\/crypto\/keys\.js$|\/dist\/index\.js$|\/tools\/(?:dex_set_trust_line|dex_swap|dex_place_limit_order|dex_cancel_order|dex_amm_deposit|dex_amm_withdraw|nft_list_for_sale|nft_buy|nft_cancel_offer)\.js$)/;
let baselineSource = null;
if (baseline) {
  const source = fs.readFileSync(path.join(root, 'dist/chain/submitter.js'), 'utf8');
  const start = source.indexOf('export async function rpcCall(');
  const end = source.indexOf('\n}', start) + 2;
  assert(start >= 0 && end > start);
  baselineSource = source.slice(start, end);
  assert(!/Wallet|signAndSubmit|walletFromSeed|import\s/.test(baselineSource));
}
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (/^(?:xrpl|libsodium-wrappers|@grpc\/)/.test(specifier)) {
      boundaryViolations.push('forbidden package:' + specifier); throw new Error('forbidden package');
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.includes('/dist/')) {
      if (blocked.test(url)) { boundaryViolations.push('forbidden module'); throw new Error('forbidden module'); }
      if (url.endsWith('/dist/chain/submitter.js')) {
        if (!baselineSource) { boundaryViolations.push('actual submitter import'); throw new Error('actual submitter import forbidden'); }
        loaded.add('baseline exact rpcCall function seam (module initializer excluded)');
        return {format:'module', source:baselineSource, shortCircuit:true};
      }
      if (url.startsWith(new URL('file://' + root + '/').href)) loaded.add(path.relative(root, fileURLToPath(url)));
    }
    return next(url, context);
  },
});
const denySocket = () => { boundaryViolations.push('real socket'); throw new Error('real socket forbidden'); };
net.Socket.prototype.connect = denySocket;
tls.default.connect = denySocket;
dgram.default.createSocket = denySocket;
let fixture = null;
let metadata = null;
let calls = [];
const fixtureFailures = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url) === 'https://metadata-fixture.invalid/item' && metadata) return metadata;
  if (String(url) !== 'https://query-fixture.invalid' || options.method !== 'POST') {
    boundaryViolations.push('unexpected fetch'); throw new Error('unexpected fetch');
  }
  const request = JSON.parse(options.body);
  if (!allowed.has(request.method)) { boundaryViolations.push('non-read RPC method'); throw new Error('only read-only RPC methods allowed'); }
  const call = {method:request.method, params:request.params[0]}; calls.push(call);
  let result;
  try { result = await fixture(call); }
  catch (error) { fixtureFailures.push(String(error)); throw error; }
  if (result?.__http) return {ok:false, status:result.__http, statusText:'fixture unavailable'};
  if (result?.__invalidJson) return {ok:true,status:200,json:async()=>{throw new SyntaxError('fixture invalid JSON');}};
  return {ok:true,status:200,json:async()=>({result})};
};
const modules = {};
for (let i=0; i<names.length; i++) {
  const mod = await import(new URL('../dist/tools/' + names[i] + '.js', import.meta.url));
  modules[names[i]] = {fn:mod['execute' + functions[i]], schema:mod[functions[i][0].toLowerCase() + functions[i].slice(1) + 'Schema']};
  assert(modules[names[i]].fn && modules[names[i]].schema);
}
const config = {pftlRpcUrl:'https://query-fixture.invalid'};
const keypair = {address:'synthetic-owner'}; // Address data only; no keys or actual account.
const H = 'A'.repeat(64);
const A = '1'.repeat(64), B = '2'.repeat(64), C = '3'.repeat(64);
const USD = {currency:'USD',issuer:'synthetic-usd'};
const TOK = {currency:'TOK',issuer:'synthetic-token'};
const amt = (asset,value) => ({...asset,value});
const ledger = result => ({ledger_hash:H,ledger_index:123,validated:true,...result});
const nft = (id,extra={}) => ({NFTokenID:id,Issuer:'synthetic-other-issuer',...extra});
const offer = (id,amount) => ({nft_offer_index:id,owner:'synthetic-seller',amount,flags:1});
const rpcError = (code,message='fixture failure') => ({error:code,error_message:message});
const noOffer = () => rpcError('objectNotFound','No matching offers');
const run = async (name,args={}) => JSON.parse(await modules[name].fn(config,keypair,modules[name].schema.parse(args)));
const cases = [];
function test(id, tool, body) { cases.push({id,tool,body}); }
function only(method, result) { return call => {assert.equal(call.method,method);return typeof result==='function'?result(call.params):result;}; }
const balances = (lines=[],extra={}) => call => call.method==='account_info' ? ledger({account_data:{Balance:'9007199254740993'}}) : (assert.equal(call.method,'account_lines'),ledger({lines,...extra}));
const ammFixture = (amount,amount2) => only('amm_info',ledger({amm:{amount,amount2,account:'synthetic-pool'}}));
const listingFixture = sell => call => call.method==='account_nfts' ? ledger({account_nfts:[nft(A)]}) : (assert.equal(call.method,'nft_sell_offers'),sell(call));

test('balances-exact-native','dex_get_balances',async()=>{fixture=balances();assert.equal((await run('dex_get_balances')).native.balance,'9007199254.740993');});
test('balances-server-continuation','dex_get_balances',async()=>{
 fixture=call=>call.method==='account_info'?ledger({account_data:{Balance:'1000000'}}):ledger({lines:[{currency:call.params.marker?'TOK':'USD',account:'synthetic-issuer',balance:'1'}],...(call.params.marker?{}:{marker:{page:2}})});
 const first=await run('dex_get_balances',{limit:1});assert(first.marker);assert.equal(first.complete,false);
 const next=await run('dex_get_balances',{limit:1,marker:first.marker});assert.equal(next.trust_lines[0].currency,'TOK');assert.equal(next.marker,null);assert.equal(next.complete,true);
 assert(calls.some(c=>c.method==='account_lines'&&c.params.marker?.page===2));assert(calls.filter(c=>c.method==='account_info').every(c=>c.params.ledger_hash===H));
});
test('balances-malformed-atoms','dex_get_balances',async()=>{fixture=call=>call.method==='account_info'?ledger({account_data:{Balance:'1junk'}}):ledger({lines:[]});await assert.rejects(()=>run('dex_get_balances'));});
test('balances-upstream-failure','dex_get_balances',async()=>{fixture=()=>({__http:503});await assert.rejects(()=>run('dex_get_balances'));});
test('book-exact-native','dex_get_order_book',async()=>{fixture=only('book_offers',ledger({offers:[{TakerPays:'9007199254740993',TakerGets:amt(USD,'4')}]}));assert.equal((await run('dex_get_order_book',{asset1:'PFT',asset2:USD})).side_a[0].taker_pays.amount,'9007199254.740993');});
test('book-both-directions','dex_get_order_book',async()=>{fixture=only('book_offers',p=>ledger({offers:[{TakerPays:p.taker_pays.currency==='XRP'?'2000000':amt(USD,'4'),TakerGets:p.taker_gets.currency==='XRP'?'2000000':amt(USD,'4')}]}));const r=await run('dex_get_order_book',{asset1:'PFT',asset2:USD});assert.equal(r.side_a[0].taker_pays.currency,'PFT');assert.equal(r.side_b[0].taker_pays.currency,'USD');});
test('book-failure-propagation','dex_get_order_book',async()=>{fixture=()=>({__http:503});await assert.rejects(()=>run('dex_get_order_book',{asset1:'PFT',asset2:USD}));});
test('amm-reversed-native-issued','dex_get_amm_info',async()=>{fixture=ammFixture(amt(USD,'4'),'2000000');const r=await run('dex_get_amm_info',{asset1:'PFT',asset2:USD});assert.equal(r.reserve1.currency,'PFT');assert.equal(r.reserve2.currency,'USD');assert.equal(r.spot_price_asset2_per_asset1,'2.00000000');});
test('amm-reversed-issued-pair','dex_get_amm_info',async()=>{fixture=ammFixture(amt(USD,'15'),amt(TOK,'3'));assert.equal((await run('dex_get_amm_info',{asset1:TOK,asset2:USD})).spot_price_asset2_per_asset1,'5.00000000');});
test('amm-normal-order','dex_get_amm_info',async()=>{fixture=ammFixture('2000000',amt(USD,'4'));assert.equal((await run('dex_get_amm_info',{asset1:'PFT',asset2:USD})).spot_price_asset2_per_asset1,'2.00000000');});
test('amm-wrong-reserve-identity','dex_get_amm_info',async()=>{fixture=ammFixture(amt(USD,'2'),amt(USD,'4'));await assert.rejects(()=>run('dex_get_amm_info',{asset1:'PFT',asset2:USD}));});
test('amm-authoritative-absence','dex_get_amm_info',async()=>{fixture=only('amm_info',rpcError('actNotFound','No matching pool'));assert.match((await run('dex_get_amm_info',{asset1:'PFT',asset2:USD})).error,/No AMM pool/);});
test('orders-exact-amount-and-issued','dex_get_open_orders',async()=>{fixture=only('account_offers',ledger({offers:[{seq:1,taker_pays:'9007199254740993',taker_gets:amt(USD,'0.125')}]}));const r=await run('dex_get_open_orders');assert.equal(r.open_orders[0].taker_pays.amount,'9007199254.740993');assert.equal(r.open_orders[0].taker_gets.issuer,USD.issuer);});
test('orders-bounded-partial-page','dex_get_open_orders',async()=>{
 fixture=only('account_offers',ledger({offers:[{seq:1,taker_pays:'1000000',taker_gets:amt(USD,'1')},{seq:2,taker_pays:'2000000',taker_gets:amt(USD,'2')}]}));
 const first=await run('dex_get_open_orders',{limit:1});assert.equal(first.count,1);assert(first.marker);const next=await run('dex_get_open_orders',{limit:1,marker:first.marker});assert.equal(next.open_orders[0].sequence,2);assert.equal(next.marker,null);assert(calls[1].params.ledger_hash===H);
});
test('orders-empty-complete','dex_get_open_orders',async()=>{fixture=only('account_offers',ledger({offers:[]}));const r=await run('dex_get_open_orders');assert.equal(r.count,0);assert.equal(r.complete,true);});
test('owned-server-marker-roundtrip','nft_get_owned',async()=>{fixture=only('account_nfts',p=>ledger({account_nfts:[nft(p.marker?B:A)],...(p.marker?{}:{marker:{page:2}})}));const first=await run('nft_get_owned');assert(first.marker);const next=await run('nft_get_owned',{marker:first.marker});assert.equal(next.nfts[0].nft_id,B);assert(calls[1].params.marker.page===2);});
test('owned-optional-metadata-failure','nft_get_owned',async()=>{metadata={ok:false,status:503};fixture=only('account_nfts',ledger({account_nfts:[nft(A,{URI:Buffer.from('https://metadata-fixture.invalid/item').toString('hex')})]}));const r=await run('nft_get_owned',{resolve_metadata:true});assert.equal(r.nfts[0].nft_id,A);assert.equal(r.nfts[0].name,undefined);});
test('owned-local-token-bound','nft_get_owned',async()=>{fixture=only('account_nfts',ledger({account_nfts:[nft(A),nft(B),nft(C)]}));let marker;const ids=[];for(let i=0;i<3;i++){const r=await run('nft_get_owned',{limit:1,...(marker?{marker}:{})});assert.equal(r.count,1);ids.push(r.nfts[0].nft_id);marker=r.marker;}assert.deepEqual(ids,[A,B,C]);assert.equal(marker,null);});
test('owned-metadata-success','nft_get_owned',async()=>{metadata={ok:true,json:async()=>({name:'Fixture NFT',image:'ipfs://fixture-image'})};fixture=only('account_nfts',ledger({account_nfts:[nft(A,{URI:Buffer.from('https://metadata-fixture.invalid/item').toString('hex')})]}));const r=await run('nft_get_owned',{resolve_metadata:true});assert.equal(r.nfts[0].name,'Fixture NFT');assert.match(r.nfts[0].image,/fixture-image$/);});
test('offers-exact-native','nft_get_offers',async()=>{fixture=only('nft_sell_offers',ledger({offers:[offer('offer-a','9007199254740993')]}));assert.equal((await run('nft_get_offers',{nft_id:A})).sell_offers[0].amount_pft,'9007199254.740993');});
test('offers-issued-fields','nft_get_offers',async()=>{fixture=only('nft_sell_offers',ledger({offers:[offer('offer-a',amt(USD,'0.125'))]}));const o=(await run('nft_get_offers',{nft_id:A})).sell_offers[0];assert.deepEqual(o.amount,{currency:'USD',issuer:USD.issuer,amount:'0.125'});assert.equal(o.amount_pft,null);});
test('offers-server-continuation','nft_get_offers',async()=>{fixture=only('nft_sell_offers',p=>ledger({offers:[offer(p.marker?'offer-b':'offer-a','1')],...(p.marker?{}:{marker:{page:2}})}));const first=await run('nft_get_offers',{nft_id:A});assert(first.marker);const next=await run('nft_get_offers',{nft_id:A,marker:first.marker});assert.equal(next.sell_offers[0].offer_id,'offer-b');assert.equal(next.complete,true);});
test('offers-authoritative-no-offer','nft_get_offers',async()=>{fixture=only('nft_sell_offers',noOffer());assert.equal((await run('nft_get_offers',{nft_id:A})).count,0);});
test('offers-http-failure-is-not-empty','nft_get_offers',async()=>{fixture=only('nft_sell_offers',{__http:503});await assert.rejects(()=>run('nft_get_offers',{nft_id:A}));});
test('offers-generic-not-found-is-not-empty','nft_get_offers',async()=>{fixture=only('nft_sell_offers',rpcError('upstreamUnavailable','Upstream not found'));await assert.rejects(()=>run('nft_get_offers',{nft_id:A}));});
test('listings-authoritative-no-offer','nft_get_listings',async()=>{fixture=listingFixture(noOffer);assert.equal((await run('nft_get_listings',{issuer:'synthetic-owner'})).count,0);});
for(const [id,error] of [['busy',rpcError('tooBusy','Server overloaded')],['http',{__http:503}],['invalid-json',{__invalidJson:true}]]) test('listings-'+id+'-is-not-empty','nft_get_listings',async()=>{fixture=listingFixture(()=>error);await assert.rejects(()=>run('nft_get_listings',{issuer:'synthetic-owner'}));});
test('listings-bound-and-resume','nft_get_listings',async()=>{fixture=call=>call.method==='account_nfts'?ledger({account_nfts:[nft(A),nft(B),nft(C)]}):ledger({offers:[offer('offer-'+call.params.nft_id,'1000000')]});let marker;const ids=[];for(let i=0;i<3;i++){const r=await run('nft_get_listings',{issuer:'synthetic-owner',limit:1,...(marker?{marker}:{})});assert.equal(r.scanned,1);ids.push(r.listings[0].nft_id);marker=r.marker;}assert.deepEqual(ids,[A,B,C]);assert.equal(marker,null);});
test('listings-truthful-account-scope','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[offer('offer-a','1000000')]}));const r=await run('nft_get_listings',{issuer:'synthetic-owner'});assert.equal(r.scope,'account_holdings');assert.equal(r.account,'synthetic-owner');assert.equal(r.listings[0].issuer,'synthetic-other-issuer');});
test('listings-account-parameter','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[]}));assert.equal((await run('nft_get_listings',{account:'synthetic-owner'})).account,'synthetic-owner');});
test('listings-offer-continuation-is-visible','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[offer('offer-a','1000000')],marker:'more-offers'}));const r=await run('nft_get_listings',{issuer:'synthetic-owner'});assert.equal(r.listings[0].offers_complete,false);assert(r.listings[0].offers_marker);assert.equal(r.listings[0].best_price_scope,'returned_native_offers');});
test('listings-issued-only-price-is-preserved','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[offer('offer-a',amt(USD,'0.125'))]}));const o=(await run('nft_get_listings',{issuer:'synthetic-owner'})).listings[0];assert.deepEqual(o.sell_offers[0].amount,{currency:'USD',issuer:USD.issuer,amount:'0.125'});assert.equal(o.best_offer_id,null);});
test('listings-native-best-uses-exact-integers','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[offer('larger','9007199254740993'),offer('smaller','9007199254740992')]}));assert.equal((await run('nft_get_listings',{issuer:'synthetic-owner'})).listings[0].best_offer_id,'smaller');});
test('cursor-wrong-account-is-rejected','nft_get_owned',async()=>{fixture=only('account_nfts',ledger({account_nfts:[nft(A),nft(B)]}));const r=await run('nft_get_owned',{address:'synthetic-a',limit:1});assert(r.marker);const before=calls.length;await assert.rejects(()=>run('nft_get_owned',{address:'synthetic-b',limit:1,marker:r.marker}));assert.equal(calls.length,before);});
test('cursor-malformed-is-rejected','nft_get_owned',async()=>{fixture=only('account_nfts',ledger({account_nfts:[]}));await assert.rejects(()=>run('nft_get_owned',{marker:'pft-query-v1.not-json'}));assert.equal(calls.length,0);});
test('cursor-changed-partial-page-is-rejected','nft_get_owned',async()=>{let count=0;fixture=only('account_nfts',()=>ledger({account_nfts:++count===1?[nft(A),nft(B)]:[nft(C),nft(B)]}));const r=await run('nft_get_owned',{limit:1});assert(r.marker);await assert.rejects(()=>run('nft_get_owned',{limit:1,marker:r.marker}));});
test('cursor-server-changed-ledger-is-rejected','nft_get_owned',async()=>{let count=0;fixture=only('account_nfts',()=>({...ledger({account_nfts:[nft(A),nft(B)]}),ledger_hash:++count===1?H:'B'.repeat(64)}));const r=await run('nft_get_owned',{limit:1});assert(r.marker);await assert.rejects(()=>run('nft_get_owned',{limit:1,marker:r.marker}));});

test('amm-malformed-success-is-not-absence','dex_get_amm_info',async()=>{fixture=only('amm_info',ledger({}));await assert.rejects(()=>run('dex_get_amm_info',{asset1:'PFT',asset2:USD}));});
test('owned-malformed-page-is-not-empty','nft_get_owned',async()=>{fixture=only('account_nfts',ledger({}));await assert.rejects(()=>run('nft_get_owned'));});
test('transport-refuses-transaction-method','transport',async()=>{fixture=()=>{throw new Error('must not fetch');};const {queryRpc}=await import('../dist/chain/query.js');await assert.rejects(()=>queryRpc(config.pftlRpcUrl,'submit',{}));assert.equal(calls.length,0);});
test('balances-pinned-account-info-must-match','dex_get_balances',async()=>{fixture=call=>call.method==='account_info'?{...ledger({account_data:{Balance:'1000000'}}),ledger_hash:'B'.repeat(64)}:ledger({lines:[]});await assert.rejects(()=>run('dex_get_balances'));});
test('listings-conflicting-account-alias-rejected','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[]}));await assert.rejects(()=>run('nft_get_listings',{account:'synthetic-a',issuer:'synthetic-b'}));assert.equal(calls.length,0);});

test('listings-empty-offer-page-with-continuation-is-not-absence','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[],marker:'more-offers'}));await assert.rejects(()=>run('nft_get_listings',{issuer:'synthetic-owner'}));});
test('listings-offer-completeness-is-scoped','nft_get_listings',async()=>{fixture=listingFixture(()=>ledger({offers:[offer('offer-a','1')],marker:'more-offers'}));const r=await run('nft_get_listings',{issuer:'synthetic-owner'});assert.equal(r.complete_scope,'account_holdings_scan');assert.equal(r.offers_complete,false);});

const results = [];
for (const c of cases) {
 calls=[];metadata=null;fixture=()=>{throw new Error('fixture not installed');};
 const before=boundaryViolations.length, failuresBefore=fixtureFailures.length;
 try { await c.body(); assert.equal(boundaryViolations.length,before);assert.equal(fixtureFailures.length,failuresBefore); results.push({id:c.id,tool:c.tool,pass:true,calls:calls.map(x=>x.method)}); }
 catch(error) {results.push({id:c.id,tool:c.tool,pass:false,error:String(error).replaceAll(root,'<checkout>'),fixtureFailures:fixtureFailures.slice(failuresBefore),calls:calls.map(x=>x.method)});}
}
hook.deregister();
const result={mode:baseline?'base exact-rpcCall seam':'head actual pure read transport',node:process.version,total:results.length,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,boundaryViolations,loadedModules:[...loaded].sort(),baselineRpcCallSHA256:baselineSource?createHash('sha256').update(baselineSource).digest('hex'):null,results};
if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
for(const r of results)console.log((r.pass?'PASS':'FAIL')+' '+r.id+(r.pass?'':' '+r.error));
console.log(`Native read-only cases: ${result.passed}/${result.total} passed; ${result.failed} failed; boundary violations=${boundaryViolations.length}`);
if(!baseline && result.failed)process.exitCode=1;
if(boundaryViolations.length || fixtureFailures.length)process.exitCode=1;
