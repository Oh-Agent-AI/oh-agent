import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import { repo, sdk } from "../../../scripts/app-contract-support.mjs";
const {build}=createRequire(`${repo}/apps/desktop/ui-dev/package.json`)("esbuild");
const compiled=(await build({entryPoints:[`${sdk}/src/city-ui-projection.ts`],bundle:true,write:false,platform:"node",format:"cjs",logLevel:"silent"})).outputFiles[0].text;
const module={exports:{}}; vm.runInNewContext(compiled,{module,exports:module.exports});
const {validateCityProjectionV2,validateCityProjectionV3}=module.exports;
const session={id:`sr_${"a".repeat(32)}`,asset_ref:`ca_${"b".repeat(32)}`,layout_order:1,harness:"harness:fixture",
  title:"Example",title_source:"plugin_title_v2",first_event_at:"2026-10-01T00:00:00Z",last_event_at:"2026-10-02T00:00:00Z",
  tokens:{input:3,uncached_input:1,cache_read:1,cache_write:1,output:2,total:5}};
const response={protocol:"city:v3",source:"local",query_semantics:"city-window-v3.1",data_revision:1,
  snapshot:`sr_${"c".repeat(32)}`,context:`sr_${"d".repeat(32)}`,window:{days:7,from_ms:1,to_ms:604800001,timezone:"UTC",boundary:"half_open",calendar_mode:"rolling"},
  page:{sessions:[session],next_cursor:null,coverage:{matched:1,returned:1,offset:0}}};
test("City v3 validates safe integers, tokens, page counts, source tokens and stable asset handles",()=>{
  assert.equal(validateCityProjectionV3(response),response);
  for (const change of [v=>v.page.sessions[0].tokens.total=99,v=>v.page.sessions[0].tokens.input=Number.MAX_SAFE_INTEGER+1,
    v=>v.page.sessions[0].tokens.cache_read=5,v=>v.page.coverage.returned=2,v=>v.page.sessions[0].title_source="",
    v=>v.page.sessions[0].asset_ref="/private/path",v=>v.window.boundary="closed",v=>v.page.sessions[0].first_event_at="bad"]) {
    const changed=structuredClone(response); change(changed); assert.throws(()=>validateCityProjectionV3(changed));
  }
});
test("v2 remains compatible while missing source is null and unknown sources are controlled tokens",()=>{
  const v2={protocol:"city:v2",harnesses:[],findings:[],sessions:[{...structuredClone(session),title_source:null}],coverage:{total:1,returned:1}};
  assert.equal(validateCityProjectionV2(v2),v2);
  v2.sessions[0].tokens.total=NaN; assert.throws(()=>validateCityProjectionV2(v2));
});

test("reference estimates require bounded price provenance and explicit uncertainty",()=>{
  const detail={...structuredClone(response),page:undefined,detail:{...session,cost:{cost_minor:null,status:"unavailable",reason:"partially_priced",
    has_unresolved:true,complete:false,breakdown:[],reference_prices:[{pricing_version:"local-card",captured_at_ms:1790995699084}]}}};
  assert.equal(validateCityProjectionV3(detail),detail);
  for (const change of [c=>c.has_unresolved=false,c=>c.reference_prices=[],c=>c.reference_prices[0].pricing_version="",
    c=>c.reference_prices[0].captured_at_ms=-1,c=>c.reference_prices[0].captured_at_ms=9000000000000000,
    c=>c.reference_prices=Array(17).fill(c.reference_prices[0])]) {
    const invalid=structuredClone(detail); change(invalid.detail.cost); assert.throws(()=>validateCityProjectionV3(invalid));
  }
});
const labelBuild=await build({entryPoints:[`${repo}/apps/agent-city/ui/src/data/sessionCostLabel.ts`],bundle:true,write:false,platform:"node",format:"cjs",logLevel:"silent"});
const labelModule={exports:{}}; vm.runInNewContext(labelBuild.outputFiles[0].text,{module:labelModule,exports:labelModule.exports});
const {sessionCostLabel}=labelModule.exports;
test("cost UI explains reference date, partial coverage, subscriptions and missing historical snapshots in both languages",()=>{
  const priced={...session,cost_minor:{amount_minor:123,currency:"USD",basis:"metered_estimate"},
    cost_reference_prices:[{pricing_version:"local-card",captured_at_ms:1790995699084}],cost_status:{state:"estimated",reason:"breakdown",has_unresolved:true}};
  assert.match(sessionCostLabel(priced,"en"),/\$1.23.*reference estimate.*2026-10-03.*not a historical bill/);
  assert.match(sessionCostLabel(priced,"zh"),/参考估价.*2026-10-03.*非历史账单/);
  for (const [reason,en,zh] of [["no-pricing-snapshot",/No local price snapshot/,/价格快照/],
    ["partially_priced",/Only part/,/部分用量/],["legacy_aggregate_not_priced",/Historical aggregate/,/历史汇总/]]) {
    const row={...session,cost_status:{state:"unavailable",reason,has_unresolved:true}};
    assert.match(sessionCostLabel(row,"en"),en); assert.match(sessionCostLabel(row,"zh"),zh);
  }
  assert.match(sessionCostLabel({...priced,cost_status:{state:"subscription",reason:"subscription",has_unresolved:false}},"en"),/Subscription usage/);
});
