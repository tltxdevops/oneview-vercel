import test from "node:test";
import assert from "node:assert/strict";
import { buildLinksPayload, parseLinkFilters } from "../api/_lib/oneview-links.js";

const filters = { customer:null,datasource:null,classification:null,state:null,ack:null,severity:null,incident:null,carrier:null,search:null,page:1,page_size:200 };
const row = (customer_name, active_alerts = 0, incident_count = 0) => ({ id:customer_name,customer_name,customer_key:customer_name.toLowerCase(),datasource:"teletex-http",classification:"wan_link",carrier_name:null,service_name:`${customer_name}_LINK`,source_host_id:"1",active_alerts,unack_alerts:active_alerts,disaster_alerts:0,high_alerts:0,average_alerts:0,warning_alerts:0,state:active_alerts?"alert":"normal",max_severity:active_alerts?"average":null,incident_count,incidents:[],alerts:[] });

test("OV-P0-278C payload keeps only canonical links and carrier null semantics", () => {
  const rows=[...Array.from({length:113},()=>row("Castrolanda")),...Array.from({length:40},()=>row("Tuper")),...Array.from({length:31},()=>row("Teletex",1)),...Array.from({length:2},()=>row("Fraport FOR",0,1))];
  const payload=buildLinksPayload(rows,filters,0);
  assert.equal(payload.totals.links,186); assert.equal(payload.totals.active_alert_links,31); assert.equal(payload.totals.incident_links,2); assert.equal(payload.totals.known_carriers,0);
  assert.deepEqual([...new Set(payload.items.map(x=>x.customer_name))].sort(),["Castrolanda","Fraport FOR","Teletex","Tuper"]);
});
test("OV-P0-278C filters preserve canonical customer, datasource-host join contract", () => {
  const req={query:{customer:"Tuper",carrier:"unknown",ack:"pending",page:"1",page_size:"50"}};
  assert.deepEqual(parseLinkFilters(req),{...filters,customer:"Tuper",carrier:"unknown",ack:"pending",page:1,page_size:50});
  assert.throws(()=>parseLinkFilters({query:{customer:"Protege;drop table"}}));
});
