/**
 * Circuit-level discovery for alerts explicitly tagged escalation=operator.
 * Pure/read-only: no database access and no persistence.
 */

const TAG_BAGS = ["event_tags", "trigger_tags", "host_tags", "template_tags"];
const CIRCUIT_TAG_KEYS = new Set(["circuit", "circuito", "circuit-id", "circuit_id", "link-key", "link_key"]);
const CARRIER_TAG_KEYS = new Set(["carrier", "operadora", "provedor", "provider", "isp"]);
const MEMBER_TAG_KEYS = new Set(["member", "member-id", "member_id", "sdwan-member", "sd-wan-member"]);
const HEALTHCHECK_TAG_KEYS = new Set(["healthcheck", "health-check", "health_check"]);
const SITE_TAG_KEYS = new Set(["site", "site-id", "site_id", "siteid", "loja", "store"]);
const CARRIERS = [
  ["vivo", "Vivo"],
  ["claro", "Claro"],
  ["embratel", "Embratel"],
  ["algar", "Algar"],
  ["tim", "TIM"],
  ["oi", "Oi"],
];

function text(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString();
}

export function stableCircuitSlug(value) {
  const input = text(value);
  if (!input) return null;
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || null;
}

function asTagList(record = {}) {
  const output = [];
  for (const bag of TAG_BAGS) {
    const values = record?.[bag];
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (!item || typeof item !== "object") continue;
      const tag = text(item.tag ?? item.name);
      const value = text(item.value);
      if (tag || value) output.push({ tag: tag || "", value: value || "", source: bag });
    }
  }
  return output;
}

export function hasExactOperatorEscalation(record) {
  return asTagList(record).some((item) => (
    item.tag.trim().toLowerCase() === "escalation"
    && item.value.trim().toLowerCase() === "operator"
  ));
}

function tagValue(tags, keys) {
  for (const item of tags) {
    if (keys.has(item.tag.trim().toLowerCase()) && text(item.value)) return text(item.value);
  }
  return null;
}

function allEvidenceText(context) {
  return [
    context.item_key,
    context.item_name,
    context.trigger_description,
    ...context.tags.map((item) => `${item.tag}=${item.value}`),
    context.problem_name,
    context.service_name,
  ].filter(Boolean).join(" | ");
}

const EVIDENCE_RANK = Object.freeze({
  item_key: 5,
  item_name: 4,
  trigger_description: 3,
  tags: 2,
  problem_name: 1,
  service_name: 0,
});

function fieldMatch(context, field, pattern, transform = (match) => match?.[1]) {
  const match = String(context[field] || "").match(pattern);
  const value = text(transform(match));
  return value ? { value, source: field, rank: EVIDENCE_RANK[field] } : null;
}

function rankedEvidence(entries) {
  const available = entries.filter((entry) => entry?.value);
  if (!available.length) return { value: null, source: null, rank: -1, conflicts: [] };
  available.sort((a, b) => b.rank - a.rank || String(a.value).localeCompare(String(b.value), "pt-BR"));
  const selected = available[0];
  return {
    ...selected,
    conflicts: available
      .filter((entry) => stableCircuitSlug(entry.value) !== stableCircuitSlug(selected.value))
      .map((entry) => ({ selected: selected.value, selected_source: selected.source, conflicting: entry.value, conflicting_source: entry.source })),
  };
}

function structuredEvidence(context, keys, rank = EVIDENCE_RANK.tags) {
  const value = tagValue(context.tags, keys);
  return value ? { value, source: "tags", rank } : null;
}

function recordContext(record) {
  const tags = asTagList(record);
  return {
    record,
    tags,
    alert_id: text(record.id),
    data_source_id: text(record.data_source_id),
    datasource: text(record.datasource ?? record.datasource_name),
    source_host_id: text(record.source_host_id),
    source_trigger_id: text(record.source_trigger_id),
    host_name: text(record.host_name ?? record.host_visible_name ?? record.host_technical_name),
    customer_key: text(record.customer_key),
    customer_name: text(record.customer_name ?? record.client_name),
    item_key: text(record.item_key),
    item_name: text(record.item_name),
    trigger_description: text(record.trigger_description),
    problem_name: text(record.problem_name),
    service_name: text(record.service_name),
    updated_at: isoDate(record.updated_at ?? record.last_seen_at),
  };
}

function evidenceFor(context) {
  const fields = {};
  for (const field of ["item_key", "item_name", "trigger_description", "problem_name"]) {
    if (context[field]) fields[field] = [context[field]];
  }
  fields.tags = context.tags.map(({ tag, value, source }) => ({ tag, value, source }));
  return fields;
}

function identitySource(context) {
  return stableCircuitSlug(context.data_source_id ?? context.datasource);
}

function identityHost(context) {
  return stableCircuitSlug(context.source_host_id ?? context.host_name);
}

function validIpv4(value) {
  const candidate = text(value);
  if (!candidate || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) return null;
  return candidate.split(".").every((part) => Number(part) <= 255) ? candidate : null;
}

function endpointIpFrom(value) {
  const matches = String(value || "").match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
  return matches.map(validIpv4).find(Boolean) || null;
}

function canonicalLinkType(value) {
  const normalized = stableCircuitSlug(value);
  if (!normalized) return null;
  if (/(^|-)mpls($|-)/.test(normalized)) return "mpls";
  if (/(^|-)(lte|4g|cellular)($|-)/.test(normalized)) return "lte";
  if (/(^|-)(public-internet|internet-publica)($|-)/.test(normalized)) return "public-internet";
  return null;
}

function carrierFrom(context) {
  const tagged = tagValue(context.tags, CARRIER_TAG_KEYS);
  const haystack = [
    tagged,
    context.item_key,
    context.item_name,
    context.trigger_description,
    context.problem_name,
    ...context.tags.map((item) => `${item.tag}=${item.value}`),
  ].filter(Boolean).join(" ");
  for (const [token, label] of CARRIERS) {
    if (new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(haystack)) {
      return { carrier_name: label, carrier_reference: tagged || label };
    }
  }
  return { carrier_name: null, carrier_reference: tagged };
}

function candidate(context, values) {
  const carrier = carrierFrom(context);
  return {
    circuit_key: values.circuit_key,
    resolution_status: values.resolution_status,
    data_source_id: context.data_source_id,
    datasource: context.datasource,
    source_host_id: context.source_host_id,
    host_name: context.host_name,
    customer_key: context.customer_key,
    customer_name: context.customer_name,
    site_key: values.site_key ?? null,
    site_name: values.site_name ?? null,
    link_type: values.link_type ?? null,
    member_key: values.member_key ?? null,
    healthcheck_key: values.healthcheck_key ?? null,
    uplink_key: values.uplink_key ?? null,
    endpoint_ip: values.endpoint_ip ?? null,
    carrier_name: values.carrier_name ?? carrier.carrier_name,
    carrier_reference: values.carrier_reference ?? carrier.carrier_reference,
    service_name: values.service_name ?? context.service_name,
    strategy: values.strategy,
    confidence: values.confidence,
    unresolved_reason: values.unresolved_reason ?? null,
    trigger_ids: context.source_trigger_id ? [context.source_trigger_id] : [],
    alert_ids: context.alert_id ? [context.alert_id] : [],
    evidence: evidenceFor(context),
    updated_at: context.updated_at,
    auxiliary: Boolean(values.auxiliary),
    identity_authority: Number.isFinite(values.identity_authority) ? values.identity_authority : -1,
    identity_source: values.identity_source ?? null,
    evidence_conflicts: values.evidence_conflicts ?? [],
  };
}

function unresolvedKey(context, strategy, parts = []) {
  const stable = [identitySource(context), identityHost(context), ...parts.map(stableCircuitSlug)].filter(Boolean);
  return `operator:v1:${strategy}-unresolved:${stable.join(":") || "missing-identity"}`;
}

function discoverFortigate(context) {
  const evidence = allEvidenceText(context);
  if (!/(fgvwlhealthcheck|fortigate|health\s*check|sd-?wan\s+member|packet\s*loss)/i.test(evidence)) return null;

  const keyMatch = String(context.item_key || "").match(/fgVWLHealthCheckLink(?:PacketLoss|State)\[([^\]]+)\]/i);
  const keyParts = keyMatch ? keyMatch[1].trim() : null;
  const packetLossKey = /fgVWLHealthCheckLinkPacketLoss/i.test(String(context.item_key || ""));
  const memberEvidence = rankedEvidence([
    packetLossKey && keyParts?.match(/\.(\d+)$/)?.[1]
      ? { value: keyParts.match(/\.(\d+)$/)[1], source: "item_key", rank: EVIDENCE_RANK.item_key }
      : null,
    fieldMatch(context, "item_name", /\bmember\s*(?:id\s*)?(?:[:#=-]\s*)?(\d+)\b/i),
    fieldMatch(context, "trigger_description", /\bmember\s*(?:id\s*)?(?:[:#=-]\s*)?(\d+)\b/i),
    structuredEvidence(context, MEMBER_TAG_KEYS),
    fieldMatch(context, "problem_name", /\bmember\s*(?:id\s*)?(?:[:#=-]\s*)?(\d+)\b/i),
    fieldMatch(context, "service_name", /\bmember\s*(?:id\s*)?(?:[:#=-]\s*)?(\d+)\b/i),
  ]);
  const member = text(memberEvidence.value);
  const healthcheckPattern = /(?:health\s*check(?:\s+state)?(?:\s+to)?|\bto)\s+([a-z0-9_.-]+)\s+(?:on|no)\s+(?:sd-?wan\s+)?member/i;
  const healthcheckEvidence = rankedEvidence([
    packetLossKey && keyParts?.match(/^(.+)\.\d+$/)?.[1]
      ? { value: keyParts.match(/^(.+)\.\d+$/)[1], source: "item_key", rank: EVIDENCE_RANK.item_key }
      : null,
    fieldMatch(context, "item_name", healthcheckPattern),
    fieldMatch(context, "trigger_description", healthcheckPattern),
    structuredEvidence(context, HEALTHCHECK_TAG_KEYS),
    fieldMatch(context, "problem_name", healthcheckPattern),
    fieldMatch(context, "service_name", healthcheckPattern),
  ]);
  const healthcheck = text(healthcheckEvidence.value);
  const source = identitySource(context);
  const host = identityHost(context);
  const healthcheckKey = stableCircuitSlug(healthcheck);
  const conflicts = [...memberEvidence.conflicts, ...healthcheckEvidence.conflicts];
  const authority = Math.min(memberEvidence.rank, healthcheckEvidence.rank);

  if (!source || !host || !member || !/^\d+$/.test(member) || !healthcheckKey) {
    return candidate(context, {
      circuit_key: unresolvedKey(context, "fortigate", [healthcheckKey, member && `member-${member}`]),
      resolution_status: "unresolved",
      link_type: null,
      member_key: member,
      healthcheck_key: healthcheckKey,
      service_name: "Circuito Fortigate pendente de classificação",
      strategy: "fortigate",
      confidence: "low",
      unresolved_reason: "fortigate_member_or_healthcheck_not_identified",
      identity_authority: Math.max(memberEvidence.rank, healthcheckEvidence.rank),
      identity_source: memberEvidence.source ?? healthcheckEvidence.source,
      evidence_conflicts: conflicts,
    });
  }
  return candidate(context, {
    circuit_key: `operator:v1:fortigate:${source}:${host}:${healthcheckKey}:member-${member}`,
    resolution_status: "resolved",
    link_type: "sd-wan",
    member_key: member,
    healthcheck_key: healthcheckKey,
    service_name: `${healthcheck} · SD-WAN member ${member}`,
    strategy: "fortigate",
    confidence: "high",
    identity_authority: authority,
    identity_source: `${healthcheckEvidence.source}+${memberEvidence.source}`,
    evidence_conflicts: conflicts,
  });
}

function discoverMeraki(context) {
  const match = String(context.item_key || "").match(/meraki\.uplink\.status\[([^\]]+)\]/i);
  if (!match) return null;
  const parts = match[1].split(",").map((part) => part.trim());
  const siteName = text(parts[0]);
  const siteKey = stableCircuitSlug(siteName);
  const uplink = stableCircuitSlug(parts[1]);
  const source = identitySource(context);
  if (!source || !siteKey || !["wan1", "wan2", "cellular"].includes(uplink)) {
    return candidate(context, {
      circuit_key: unresolvedKey(context, "meraki", [siteKey, uplink]),
      resolution_status: "unresolved",
      site_key: siteKey,
      site_name: siteName,
      uplink_key: uplink,
      service_name: "Uplink Meraki pendente de classificação",
      strategy: "meraki",
      confidence: "low",
      unresolved_reason: "meraki_site_or_uplink_not_identified",
      identity_authority: EVIDENCE_RANK.item_key,
      identity_source: "item_key",
    });
  }
  return candidate(context, {
    circuit_key: `operator:v1:meraki:${source}:${siteKey}:${uplink}`,
    resolution_status: "resolved",
    site_key: siteKey,
    site_name: siteName,
    link_type: "uplink",
    uplink_key: uplink,
    service_name: `${siteName} · ${uplink}`,
    strategy: "meraki",
    confidence: "high",
    identity_authority: EVIDENCE_RANK.item_key,
    identity_source: "item_key",
  });
}

function parsedEvidence(context, field, parser) {
  const value = text(parser(String(context[field] || "")));
  return value ? { value, source: field, rank: EVIDENCE_RANK[field] } : null;
}

function parsedTagEvidence(context, parser) {
  const value = text(parser(context.tags.map((item) => `${item.tag}=${item.value}`).join(" ")));
  return value ? { value, source: "tags", rank: EVIDENCE_RANK.tags } : null;
}

function siteEvidence(context) {
  const pattern = /\b(?:site(?:[_ -]?id)?|loja|store)\s*(?:[:=#-]\s*|\s+)([\p{L}\p{N}][\p{L}\p{N}._-]{0,79})/iu;
  return rankedEvidence([
    fieldMatch(context, "item_key", pattern),
    fieldMatch(context, "item_name", pattern),
    fieldMatch(context, "trigger_description", pattern),
    structuredEvidence(context, SITE_TAG_KEYS),
    fieldMatch(context, "problem_name", pattern),
    fieldMatch(context, "service_name", pattern),
  ]);
}

function discoverSanepar(context) {
  const itemKey = String(context.item_key || "");
  if (!/sdwan\.(?:tunel\.(?:classe|reachability)|reachability)\[/i.test(itemKey)) return null;
  const endpointEvidence = rankedEvidence([
    parsedEvidence(context, "item_key", endpointIpFrom),
    parsedEvidence(context, "item_name", endpointIpFrom),
    parsedEvidence(context, "trigger_description", endpointIpFrom),
    parsedEvidence(context, "problem_name", endpointIpFrom),
    parsedEvidence(context, "service_name", endpointIpFrom),
  ]);
  const typeEvidence = rankedEvidence([
    parsedEvidence(context, "item_key", canonicalLinkType),
    parsedEvidence(context, "item_name", canonicalLinkType),
    parsedEvidence(context, "trigger_description", canonicalLinkType),
    parsedTagEvidence(context, canonicalLinkType),
    parsedEvidence(context, "problem_name", canonicalLinkType),
    parsedEvidence(context, "service_name", canonicalLinkType),
  ]);
  const site = siteEvidence(context);
  const endpointIp = endpointEvidence.value;
  const siteName = site.value;
  const siteKey = stableCircuitSlug(siteName);
  const linkType = typeEvidence.value;
  const source = identitySource(context);
  const isAuxiliary = /sdwan\.reachability\[/i.test(itemKey) && !/sdwan\.tunel\./i.test(itemKey) && !linkType;
  const conflicts = [...endpointEvidence.conflicts, ...typeEvidence.conflicts, ...site.conflicts];
  const authority = Math.min(endpointEvidence.rank, typeEvidence.rank, site.rank);

  if (source && siteKey && linkType && endpointIp) {
    return candidate(context, {
      circuit_key: `operator:v1:sanepar:${source}:site-${siteKey}:${linkType}:${endpointIp}`,
      resolution_status: "resolved",
      site_key: siteKey,
      site_name: siteName,
      link_type: linkType,
      endpoint_ip: endpointIp,
      service_name: `${siteName} · ${linkType.toUpperCase()} · ${endpointIp}`,
      strategy: "sanepar",
      confidence: "high",
      identity_authority: authority,
      identity_source: `${site.source}+${typeEvidence.source}+${endpointEvidence.source}`,
      evidence_conflicts: conflicts,
    });
  }
  return candidate(context, {
    circuit_key: unresolvedKey(context, "sanepar", [siteKey && `site-${siteKey}`, endpointIp]),
    resolution_status: "unresolved",
    site_key: siteKey,
    site_name: siteName,
    link_type: null,
    endpoint_ip: endpointIp,
    service_name: "Circuito Sanepar pendente de classificação",
    strategy: "sanepar",
    confidence: "low",
    unresolved_reason: isAuxiliary ? "sanepar_auxiliary_without_objective_match" : "sanepar_missing_site_type_or_ip",
    auxiliary: isAuxiliary,
    identity_authority: Math.max(endpointEvidence.rank, typeEvidence.rank, site.rank),
    identity_source: endpointEvidence.source ?? typeEvidence.source ?? site.source,
    evidence_conflicts: conflicts,
  });
}

function discoverGeneric(context) {
  const evidence = allEvidenceText(context);
  const linkMatch = evidence.match(/\blink\s+(mpls|lte|4g|public[\s_-]*internet)\b/i);
  if (!linkMatch) {
    return candidate(context, {
      circuit_key: unresolvedKey(context, "generic"),
      resolution_status: "unresolved",
      service_name: "Circuito pendente de classificação",
      strategy: "generic",
      confidence: "low",
      unresolved_reason: "operator_without_stable_circuit_identity",
      identity_authority: -1,
    });
  }
  const linkType = canonicalLinkType(linkMatch[1]);
  const taggedReference = tagValue(context.tags, CIRCUIT_TAG_KEYS);
  const parsedReference = evidence.match(/\b(?:circuito|circuit|link[_ -]?key)\s*[:=#-]\s*([\p{L}\p{N}._/-]+)/iu)?.[1] || null;
  const endpointIp = endpointIpFrom(evidence);
  const reference = text(taggedReference ?? parsedReference ?? endpointIp);
  const source = identitySource(context);
  const host = identityHost(context);
  const referenceKey = stableCircuitSlug(reference);
  if (!source || !host || !linkType || !referenceKey) {
    return candidate(context, {
      circuit_key: unresolvedKey(context, "generic", [linkType]),
      resolution_status: "unresolved",
      link_type: null,
      endpoint_ip: endpointIp,
      service_name: "Circuito pendente de classificação",
      strategy: "generic",
      confidence: "low",
      unresolved_reason: "generic_without_stable_identity",
      identity_authority: taggedReference ? EVIDENCE_RANK.tags : EVIDENCE_RANK.problem_name,
      identity_source: taggedReference ? "tags" : "text",
    });
  }
  return candidate(context, {
    circuit_key: `operator:v1:generic:${source}:${host}:${linkType}:${referenceKey}`,
    resolution_status: "resolved",
    link_type: linkType,
    endpoint_ip: endpointIp,
    carrier_reference: reference,
    service_name: `Link ${linkType.toUpperCase()} · ${reference}`,
    strategy: "generic",
    confidence: taggedReference || parsedReference ? "high" : "medium",
    identity_authority: taggedReference ? EVIDENCE_RANK.tags : EVIDENCE_RANK.problem_name,
    identity_source: taggedReference ? "tags" : "text",
  });
}

function discoverOne(record) {
  const context = recordContext(record);
  return discoverFortigate(context)
    ?? discoverMeraki(context)
    ?? discoverSanepar(context)
    ?? discoverGeneric(context);
}

function triggerIdentity(context) {
  if (context.data_source_id && context.source_host_id && context.source_trigger_id) {
    return `${context.data_source_id}:${context.source_host_id}:${context.source_trigger_id}`;
  }
  return `incomplete:${context.alert_id || stableCircuitSlug(JSON.stringify(context.record)) || "unknown"}`;
}

function technicalStrategyClaims(records) {
  const claims = new Set();
  for (const record of records) {
    const key = String(record?.item_key || "");
    if (/fgVWLHealthCheckLink(?:PacketLoss|State)\[/i.test(key)) claims.add("fortigate");
    if (/meraki\.uplink\.status\[/i.test(key)) claims.add("meraki");
    if (/sdwan\.(?:tunel\.(?:classe|reachability)|reachability)\[/i.test(key)) claims.add("sanepar");
  }
  return [...claims];
}

function stableDiagnosticHash(values) {
  let hash = 2166136261;
  for (const char of values.join("|").split("")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function mergeEvidence(candidates) {
  const output = { item_key: [], item_name: [], trigger_description: [], problem_name: [], tags: [] };
  for (const item of candidates) {
    for (const field of ["item_key", "item_name", "trigger_description", "problem_name"]) {
      output[field].push(...(item.evidence?.[field] || []));
    }
    output.tags.push(...(item.evidence?.tags || []));
  }
  for (const field of ["item_key", "item_name", "trigger_description", "problem_name"]) {
    output[field] = uniqueSorted(output[field]);
  }
  output.tags = [...new Map(output.tags.map((tag) => [JSON.stringify(tag), tag])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "pt-BR"));
  return output;
}

function choose(candidates, field) {
  return uniqueSorted(candidates.map((item) => item[field]))[0] || null;
}

function mergeCandidates(candidates) {
  const first = candidates[0];
  return {
    ...first,
    datasource: choose(candidates, "datasource"),
    host_name: choose(candidates, "host_name"),
    customer_key: choose(candidates, "customer_key"),
    customer_name: choose(candidates, "customer_name"),
    carrier_name: choose(candidates, "carrier_name"),
    carrier_reference: choose(candidates, "carrier_reference"),
    trigger_ids: uniqueSorted(candidates.flatMap((item) => item.trigger_ids)),
    alert_ids: uniqueSorted(candidates.flatMap((item) => item.alert_ids)),
    evidence: mergeEvidence(candidates),
    updated_at: uniqueSorted(candidates.map((item) => item.updated_at)).at(-1) || null,
    auxiliary: candidates.every((item) => item.auxiliary),
    evidence_conflicts: [...new Map(candidates
      .flatMap((item) => item.evidence_conflicts || [])
      .map((conflict) => [JSON.stringify(conflict), conflict])).values()],
  };
}

function ambiguousCandidate(candidates, strategy, reason = "conflicting_same_authority_identity") {
  const ordered = [...candidates].sort((a, b) => String(a.circuit_key).localeCompare(String(b.circuit_key), "pt-BR"));
  const merged = mergeCandidates(ordered);
  const source = stableCircuitSlug(merged.data_source_id ?? merged.datasource) || "missing-source";
  const host = stableCircuitSlug(merged.source_host_id ?? merged.host_name) || "missing-host";
  const candidateKeys = uniqueSorted(ordered.map((item) => item.circuit_key));
  return {
    ...merged,
    circuit_key: `operator:v1:${strategy}-ambiguous:${source}:${host}:${stableDiagnosticHash(candidateKeys)}`,
    resolution_status: "ambiguous",
    link_type: null,
    member_key: null,
    healthcheck_key: null,
    uplink_key: null,
    carrier_name: null,
    carrier_reference: null,
    service_name: "Circuito com identidade ambÃ­gua",
    confidence: "low",
    unresolved_reason: reason,
    auxiliary: false,
    candidate_keys: candidateKeys,
  };
}

function resolveTriggerGroup(records) {
  const candidates = records.map(discoverOne);
  const technicalClaims = technicalStrategyClaims(records);
  if (technicalClaims.length > 1) {
    return ambiguousCandidate(candidates, "operator", "conflicting_technical_strategies");
  }
  const strategy = technicalClaims[0]
    ?? ["fortigate", "meraki", "sanepar", "generic"].find((name) => candidates.some((item) => item.strategy === name))
    ?? "generic";
  const claimed = candidates.filter((item) => item.strategy === strategy);
  const resolved = claimed.filter((item) => item.resolution_status === "resolved");
  const selectable = resolved.length ? resolved : claimed;
  const maxAuthority = Math.max(...selectable.map((item) => item.identity_authority ?? -1));
  const strongest = selectable.filter((item) => (item.identity_authority ?? -1) === maxAuthority);
  const strongestKeys = uniqueSorted(strongest.map((item) => item.circuit_key));
  if (strongestKeys.length > 1) {
    return ambiguousCandidate(candidates, strategy);
  }
  const winner = [...strongest].sort((a, b) => String(a.circuit_key).localeCompare(String(b.circuit_key), "pt-BR"))[0]
    ?? claimed[0]
    ?? candidates[0];
  const conflicts = uniqueSorted(candidates
    .filter((item) => item.circuit_key !== winner.circuit_key)
    .map((item) => item.circuit_key));
  const merged = mergeCandidates([winner, ...candidates.filter((item) => item !== winner)]);
  if (conflicts.length) {
    merged.evidence_conflicts.push({
      selected: winner.circuit_key,
      selected_source: winner.identity_source,
      conflicting: conflicts.join(", "),
      conflicting_source: "lower_authority_history",
    });
  }
  return merged;
}

function resolveSaneparAuxiliary(candidate, resolved) {
  if (candidate.evidence_conflicts?.length) return { status: "unresolved", matches: [] };
  const eligible = resolved.filter((circuit) => (
    circuit.strategy === "sanepar"
    && circuit.resolution_status === "resolved"
    && candidate.data_source_id === circuit.data_source_id
    && candidate.source_host_id === circuit.source_host_id
  ));
  const exact = eligible.filter((circuit) => (
    candidate.endpoint_ip
    && candidate.endpoint_ip === circuit.endpoint_ip
  ));
  if (exact.length === 1) return { status: "resolved", matches: exact };
  if (exact.length > 1) return { status: "ambiguous", matches: exact };
  if (!candidate.site_key) return { status: "unresolved", matches: [] };
  const bySite = eligible.filter((circuit) => candidate.site_key === circuit.site_key);
  const linkTypes = new Set(bySite.map((circuit) => circuit.link_type).filter(Boolean));
  if (bySite.length === 1 && linkTypes.size === 1) return { status: "resolved", matches: bySite };
  if (bySite.length > 1 || linkTypes.size > 1) return { status: "ambiguous", matches: bySite };
  return { status: "unresolved", matches: [] };
}

export function assertExclusiveOperatorCircuitOwnership(circuits) {
  const triggerOwner = new Map();
  const alertOwner = new Map();
  for (const circuit of circuits) {
    for (const triggerId of circuit.trigger_ids || []) {
      const identity = `${circuit.data_source_id || ""}:${circuit.source_host_id || ""}:${triggerId}`;
      const owner = triggerOwner.get(identity);
      if (owner && owner !== circuit.circuit_key) {
        const error = new Error(`operator_trigger_owner_conflict:${identity}`);
        error.code = "operator_trigger_owner_conflict";
        throw error;
      }
      triggerOwner.set(identity, circuit.circuit_key);
    }
    for (const alertId of circuit.alert_ids || []) {
      const owner = alertOwner.get(String(alertId));
      if (owner && owner !== circuit.circuit_key) {
        const error = new Error(`operator_alert_owner_conflict:${alertId}`);
        error.code = "operator_alert_owner_conflict";
        throw error;
      }
      alertOwner.set(String(alertId), circuit.circuit_key);
    }
  }
  return { triggerOwner, alertOwner };
}

export function discoverOperatorCircuits(records = []) {
  const eligible = records.filter((record) => record && typeof record === "object" && hasExactOperatorEscalation(record));
  const triggerGroups = new Map();
  for (const record of eligible) {
    const identity = triggerIdentity(recordContext(record));
    const current = triggerGroups.get(identity) || [];
    current.push(record);
    triggerGroups.set(identity, current);
  }
  const candidates = [...triggerGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([, group]) => resolveTriggerGroup(group));
  const resolvedGroups = new Map();
  const unresolved = [];
  for (const item of candidates) {
    if (item.resolution_status === "resolved") {
      const current = resolvedGroups.get(item.circuit_key) || [];
      current.push(item);
      resolvedGroups.set(item.circuit_key, current);
    } else {
      unresolved.push(item);
    }
  }

  const resolved = [...resolvedGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([, group]) => mergeCandidates(group));
  const remaining = [];
  for (const item of unresolved) {
    if (item.strategy === "sanepar" && item.auxiliary) {
      const association = resolveSaneparAuxiliary(item, resolved);
      if (association.status === "resolved") {
        const target = association.matches[0];
        Object.assign(target, mergeCandidates([target, { ...item, circuit_key: target.circuit_key, resolution_status: "resolved" }]));
        continue;
      }
      if (association.status === "ambiguous") {
        const ambiguous = ambiguousCandidate([item], "sanepar", "sanepar_auxiliary_ambiguous_match");
        ambiguous.candidate_keys = uniqueSorted(association.matches.map((circuit) => circuit.circuit_key));
        remaining.push(ambiguous);
        continue;
      }
    }
    remaining.push(item);
  }

  const unresolvedGroups = new Map();
  for (const item of remaining) {
    const current = unresolvedGroups.get(item.circuit_key) || [];
    current.push(item);
    unresolvedGroups.set(item.circuit_key, current);
  }
  const unresolvedCircuits = [...unresolvedGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([, group]) => mergeCandidates(group));
  const output = [...resolved, ...unresolvedCircuits];
  assertExclusiveOperatorCircuitOwnership(output);
  return output;
}
