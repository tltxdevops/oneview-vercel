import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildHostNetwork } from "../api/_lib/oneview-host-network.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("host com interface main/IP publica IP principal e metadados", () => {
  const network = buildHostNetwork([{
    interfaceid: "1", type: "2", main: "1", useip: "1", ip: "10.20.30.40",
    dns: "router-a.example", port: "161", available: "1", error: "",
  }]);
  assert.deepEqual(network.primary_ip, "10.20.30.40");
  assert.equal(network.primary_dns, "router-a.example");
  assert.equal(network.interface_type, "SNMP");
  assert.equal(network.port, "161");
});

test("host DNS main não promove IP secundário a principal", () => {
  const network = buildHostNetwork([{
    interfaceid: "1", type: "1", main: "1", useip: "0", ip: "10.20.30.40",
    dns: "agent-a.example", port: "10050", available: "1", error: "",
  }]);
  assert.equal(network.primary_ip, null);
  assert.equal(network.primary_dns, "agent-a.example");
  assert.equal(network.interfaces[0].ip, "10.20.30.40");
});

test("múltiplas interfaces não escolhem secundária silenciosamente", () => {
  const network = buildHostNetwork([
    { interfaceid: "main", type: "2", main: "1", useip: "1", ip: "", dns: "", port: "161", available: "1" },
    { interfaceid: "secondary", type: "1", main: "0", useip: "1", ip: "10.99.99.99", dns: "", port: "10050", available: "1" },
  ]);
  assert.equal(network.primary_ip, null);
  assert.equal(network.primary_dns, null);
  assert.equal(network.interfaces[1].ip, "10.99.99.99");
});

test("host sem interface permanece indisponível", () => {
  assert.deepEqual(buildHostNetwork([]), {
    primary_ip: null,
    primary_dns: null,
    interface_type: null,
    port: null,
    available: null,
    interfaces: [],
  });
});

test("detail BFF usa inventário persistido; browser não chama Zabbix nem recebe token", async () => {
  const [db, api, drawer] = await Promise.all([
    read("api/_lib/oneview-db.js"),
    read("src/lib/oneview-api.ts"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);
  assert.match(db, /left join zabbix_host_inventory host_inventory/);
  assert.match(db, /host_inventory\.interfaces as host_interfaces/);
  assert.match(db, /host_network: buildHostNetwork\(row\.host_interfaces\)/);
  assert.match(api, /\/api/);
  assert.doesNotMatch(`${api}\n${drawer}`, /zabbix\.invalid|api_jsonrpc|ZABBIX_API|ZABBIX_TOKEN|Authorization:\s*Bearer/);
  assert.match(drawer, /IP principal/);
  assert.match(drawer, /Indisponível na origem/);
});
