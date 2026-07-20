import fs from "node:fs";

const PASSWORD_KEYS = new Set(["POSTGRES_READONLY_PASSWORD"]);
const INVISIBLE_CHARACTERS = /[\u00a0\u200b-\u200d\u2060\ufeff\r]/u;

function auditIssue(key, problem) {
  return { key, problem };
}

export function inspectLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      modifiedAt: null,
      hasBom: false,
      entries: [],
      issues: [],
    };
  }

  const source = fs.readFileSync(filePath, "utf8");
  const stats = fs.statSync(filePath);
  const hasBom = source.startsWith("\ufeff");
  const entries = [];
  const issues = [];
  const counts = new Map();

  source.split("\n").forEach((sourceLine, index) => {
    let line = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
    if (index === 0 && line.startsWith("\ufeff")) line = line.slice(1);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !line.includes("=")) return;

    const separator = line.indexOf("=");
    const rawKey = line.slice(0, separator);
    const key = rawKey.trim();
    const rawValue = line.slice(separator + 1);
    const valueText = rawValue.trim();
    const quote = valueText.startsWith('"') ? '"' : valueText.startsWith("'") ? "'" : null;
    const quoteClosed = quote ? valueText.length >= 2 && valueText.endsWith(quote) : true;
    const parsedValue = quote && quoteClosed ? valueText.slice(1, -1) : valueText;

    counts.set(key, (counts.get(key) || 0) + 1);
    entries.push({ key, value: parsedValue, line: index + 1 });

    if (rawKey !== key) issues.push(auditIssue(key, "whitespace_in_key"));
    if (quote && !quoteClosed) issues.push(auditIssue(key, "unclosed_quote"));
    if (!quote && valueText.includes("#")) issues.push(auditIssue(key, "unquoted_hash"));
    if (PASSWORD_KEYS.has(key) && INVISIBLE_CHARACTERS.test(rawValue)) {
      issues.push(auditIssue(key, "invisible_or_cr_character"));
    }
  });

  for (const [key, count] of counts) {
    if (count > 1) issues.push(auditIssue(key, "duplicate_key"));
  }
  if (hasBom) issues.push(auditIssue(".env.local", "bom_at_start"));

  return {
    exists: true,
    modifiedAt: stats.mtime.toISOString(),
    hasBom,
    entries,
    issues,
  };
}

export function loadLocalEnv(filePath, env = process.env) {
  const inspection = inspectLocalEnv(filePath);
  for (const entry of inspection.entries) {
    if (!(entry.key in env)) env[entry.key] = entry.value;
  }
  return inspection;
}
