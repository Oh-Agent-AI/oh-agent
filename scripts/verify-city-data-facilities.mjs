import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const requireUi=createRequire(path.join(repo,"apps/agent-city/ui/package.json"));
const {build}=createRequire(path.join(repo,"apps/desktop/ui-dev/package.json"))("esbuild");
async function load(file) {
  const compiled=await build({entryPoints:[path.join(repo,file)],bundle:true,write:false,format:"cjs",platform:"node",external:["react","react-dom/server"],logLevel:"silent"});
  const module={exports:{}}; const window={addEventListener(){},removeEventListener(){}};window.parent=window;
  vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:requireUi,window,navigator:{language:"en"},location:{href:"http://localhost/",search:""},URL,URLSearchParams,console});
  return module.exports;
}
const {cityDataPlaceForDecor,CITY_DATA_PLACES}=await load("apps/agent-city/ui/src/cityDataPlaces.ts");
assert.equal(cityDataPlaceForDecor("decor:civic:hospital#civic:7"),"findings");
assert.equal(cityDataPlaceForDecor("decor:civic:school#civic:2"),"skills");
assert.equal(cityDataPlaceForDecor("decor:site:civic"),"overview");
assert.equal(cityDataPlaceForDecor("decor:site:station"),"workflow");
assert.equal(cityDataPlaceForDecor("decor:site:tower"),"activity");
assert.equal(cityDataPlaceForDecor("decor:civic:mall#other"),null);
assert.equal(new Set(CITY_DATA_PLACES.map((p)=>p.id)).size,5);
const {CityDataFacility}=await load("apps/agent-city/ui/src/CityDataFacility.tsx");
const React=requireUi("react"), {renderToString}=requireUi("react-dom/server");
const projection={protocol:"city:v2",source:"fixture",window:{days:30,from:"2026-09-01T00:00:00Z",to:"2026-10-01T00:00:00Z"},
  sessions:[],harnesses:[],findings:[],generated_at:"2026-10-01T00:00:00Z",coverage:{total:4101,returned:4000,truncated:true,unknown_time:0},
  summary:{session_count:4101,usage_event_count:41010,tokens:{input:10000,output:0,total:10000,uncached_input:9000,cache_read:1000,cache_write:0}}};
const html=renderToString(React.createElement(CityDataFacility,{id:"overview",projection,language:"en",onClose(){},onLocate(){return false;}}));
assert(html.includes("4,101"));assert(html.includes("10,000"));assert(html.includes("Usage fact rows"));assert(html.includes("Synthetic demo data"));
assert(html.includes("loaded subset"));
console.log("City data facilities: picked building routes, complete-window totals and explicit source/scope passed.");
