import { cn } from "@/lib/utils";

export type ClientIdentityCustomer = {
  key?: string | null;
  name?: string | null;
  /** `customer_source` do alerta, quando disponível. */
  source?: string | null;
  operational_scope?: string | null;
  operational_scope_label?: string | null;
};

export type HostIdentityFields = {
  host_visible_name?: string | null;
  host_technical_name?: string | null;
  host_name?: string | null;
};

/** Legado detectável em dados antigos — nunca exibir em superfícies operacionais (OV-P0-102). */
export const UNCLASSIFIED_CLIENT_LABEL = "Cliente não classificado";
export const CLASSIFICATION_PENDING_LABEL = "Classificação ainda não determinada";
export const MISSING_HOST_LABEL = "Host não informado";
export const PLATFORM_SCOPE_LABEL = "Infraestrutura de monitoramento";
export const TEST_SCOPE_LABEL = "Ambiente de teste";
/** Fallback operacional único para unknown/null (OV-P0-102). */
export const UNKNOWN_SCOPE_LABEL = "Cliente não identificado";

export type OperationalScope = "customer" | "platform" | "test" | "unknown";

export type OperationalScopeFields = {
  operational_scope?: string | null;
  operational_scope_label?: string | null;
};

/** Escopo não-cliente do BFF (OV-P0-56) — sem inferência no frontend. */
export function normalizeOperationalScope(value?: string | null): OperationalScope | null {
  const scope = String(value || "").trim().toLowerCase();
  if (scope === "customer" || scope === "platform" || scope === "test" || scope === "unknown") {
    return scope;
  }
  return null;
}

/**
 * Rótulo operacional vindo do BFF (OV-P0-102).
 * customer real → nome; platform/test → labels de escopo; unknown/null → Cliente não identificado.
 * Nunca exibe "Cliente não classificado".
 */
export function operationalClientLabel(
  entity?: (ClientIdentityCustomer & OperationalScopeFields) | null,
  fallback = UNKNOWN_SCOPE_LABEL,
) {
  // 1) Cliente real/classificado → nunca sobrescrever com operational_scope_label.
  if (!isUnclassifiedClient(entity)) {
    return canonicalClientName(entity, fallback);
  }

  // 2) Sem customer real → operational_scope(_label) decide.
  const scope = normalizeOperationalScope(entity?.operational_scope);
  const label = String(entity?.operational_scope_label || "").trim();
  if (scope === "platform") return label || PLATFORM_SCOPE_LABEL;
  if (scope === "test") return label || TEST_SCOPE_LABEL;
  if (scope === "unknown") return label || UNKNOWN_SCOPE_LABEL;
  if (label === PLATFORM_SCOPE_LABEL || label === TEST_SCOPE_LABEL || label === UNKNOWN_SCOPE_LABEL) {
    return label;
  }
  if (scope === "customer" && label && label !== UNCLASSIFIED_CLIENT_LABEL) return label;
  return fallback === UNCLASSIFIED_CLIENT_LABEL ? UNKNOWN_SCOPE_LABEL : fallback;
}

/**
 * Label de facet/filtro de cliente (OV-P0-102).
 * key unclassified / placeholder → Cliente não identificado; sem inventar opção artificial.
 */
export function facetCustomerDisplayName(
  customer?: { key?: string | null; name?: string | null; source?: string | null } | null,
) {
  if (!customer) return UNKNOWN_SCOPE_LABEL;
  if (isUnclassifiedClient(customer)) return UNKNOWN_SCOPE_LABEL;
  const name = String(customer.name || "").trim();
  if (name && name !== UNCLASSIFIED_CLIENT_LABEL) return name;
  return UNKNOWN_SCOPE_LABEL;
}

export function isNonCustomerOperationalScope(scope?: string | null) {
  const normalized = normalizeOperationalScope(scope);
  return normalized === "platform" || normalized === "test" || normalized === "unknown";
}

/**
 * OV-P0-61 — rótulo de Histórico (Eventos/Alertas).
 * Customer real prevalece; sem customer usa scope_label; nunca "Cliente não classificado".
 */
export function historyEventClientLabel(
  entity?: OperationalScopeFields & ClientIdentityCustomer | null,
) {
  if (!isUnclassifiedClient(entity)) {
    return canonicalClientName(entity, UNKNOWN_SCOPE_LABEL);
  }
  const scope = normalizeOperationalScope(entity?.operational_scope);
  const label = String(entity?.operational_scope_label || "").trim();
  if (scope === "platform") return label || PLATFORM_SCOPE_LABEL;
  if (scope === "test") return label || TEST_SCOPE_LABEL;
  if (scope === "unknown") return label || UNKNOWN_SCOPE_LABEL;
  if (label === PLATFORM_SCOPE_LABEL || label === TEST_SCOPE_LABEL || label === UNKNOWN_SCOPE_LABEL) {
    return label;
  }
  return UNKNOWN_SCOPE_LABEL;
}

const TELETEX_LOGO_SRC = "/tltx/clientes/logos/teletex-logo.png";

const CUSTOMER_LOGO_CATALOG = [
  { aliases: ["ailos"], src: "/tltx/clientes/logos/Ailos.png" },
  { aliases: ["alubauen"], src: "/tltx/clientes/logos/Alubauem-logo-new.png" },
  { aliases: ["arauco"], src: "/tltx/clientes/logos/arauco-logo.jpg" },
  { aliases: ["berneck"], src: "/tltx/clientes/logos/berneck-logo.png" },
  { aliases: ["bnb", "banco do nordeste"], src: "/tltx/clientes/logos/bnb-logo.png" },
  { aliases: ["brinks"], src: "/tltx/clientes/logos/logo-brinks.png" },
  { aliases: ["castrolanda"], src: "/tltx/clientes/logos/castrolanda-logo.png" },
  { aliases: ["ciser"], src: "/tltx/clientes/logos/ciser-logo.png" },
  { aliases: ["copel"], src: "/tltx/clientes/logos/copel-logo.png" },
  { aliases: ["essentia"], src: "/tltx/clientes/logos/essentia-logo.png" },
  { aliases: ["estacio"], src: "/tltx/clientes/logos/estacio-logo.png" },
  { aliases: ["fps"], src: "/tltx/clientes/logos/FPS.png" },
  { aliases: ["fraport"], src: "/tltx/clientes/logos/fraport-logo.png" },
  { aliases: ["havan"], src: "/tltx/clientes/logos/havan-logo.png" },
  { aliases: ["nissan"], src: "/tltx/clientes/logos/nissan-logo.png" },
  { aliases: ["ntn"], src: "/tltx/clientes/logos/ntn-logo.png" },
  { aliases: ["osasco"], src: "/tltx/clientes/logos/osasco-logo.png" },
  { aliases: ["protege"], src: "/tltx/clientes/logos/Protege-logo.png" },
  { aliases: ["sanepar"], src: "/tltx/clientes/logos/logo-sanepar.png" },
  { aliases: ["sapore"], src: "/tltx/clientes/logos/sapore-logo1.jpg" },
  { aliases: ["sesi"], src: "/tltx/clientes/logos/sesi-logo.png" },
  { aliases: ["teletex"], src: TELETEX_LOGO_SRC },
  { aliases: ["tjba", "tribunal de justica da bahia"], src: "/tltx/clientes/logos/tjba-logo.png" },
  { aliases: ["tullett"], src: "/tltx/clientes/logos/tullett-logo.png" },
  { aliases: ["tuper"], src: "/tltx/clientes/logos/tuper-logo.png" },
  { aliases: ["unicap"], src: "/tltx/clientes/logos/unicap-logo.png" },
  { aliases: ["unimed"], src: "/tltx/clientes/logos/unimed-logo.png" },
  { aliases: ["zurich"], src: "/tltx/clientes/logos/zurich-logo.png" },
] as const;

function isAllCustomersSelection(customer?: ClientIdentityCustomer | null) {
  const key = String(customer?.key || "").trim().toLowerCase();
  const name = String(customer?.name || "").trim().toLowerCase();
  return key === "all" || name === "todos" || name === "todos os clientes";
}

function normalizedClientKey(...values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isDatasourceLikeLabel(normalized: string) {
  if (!normalized) return false;
  return (
    normalized === "teletex-http"
    || normalized.includes("datasource")
    || /(^|[\s_-])http($|[\s_-])/.test(normalized)
    || normalized.endsWith("-http")
  );
}

function isPlaceholderClientLabel(normalized: string) {
  if (!normalized) return true;
  return (
    normalized === "unclassified"
    || normalized === "cliente-nao-classificado"
    || normalized === "cliente nao classificado"
    || normalized === "cliente nao identificado"
    || normalized === "sem classificacao"
  );
}

/**
 * Cliente sem classificação confiável (UI).
 * Cliente real (nome válido) nunca é escondido — mesmo com source inconsistente.
 */
export function isUnclassifiedClient(customer?: ClientIdentityCustomer | null) {
  if (isAllCustomersSelection(customer)) return false;
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  const source = String(customer?.source || "").trim().toLowerCase();
  const normalizedName = normalizedClientKey(name);
  const normalizedKey = normalizedClientKey(key);

  const hasRealName = Boolean(name)
    && !isPlaceholderClientLabel(normalizedName)
    && !isDatasourceLikeLabel(normalizedName);
  if (hasRealName) return false;

  const hasRealKey = Boolean(key)
    && !isPlaceholderClientLabel(normalizedKey)
    && !isDatasourceLikeLabel(normalizedKey);
  if (hasRealKey) return false;

  if (source === "datasource_fallback") return true;
  if (isPlaceholderClientLabel(normalizedKey) || isPlaceholderClientLabel(normalizedName)) return true;
  if (isDatasourceLikeLabel(normalizedName) || isDatasourceLikeLabel(normalizedKey)) return true;
  return !normalizedName && !normalizedKey;
}

/** Nome de cliente para UI — nunca exibe "unclassified" nem usa datasource como cliente. */
export function canonicalClientName(
  customer?: ClientIdentityCustomer | null,
  fallback = UNKNOWN_SCOPE_LABEL,
) {
  const safeFallback = fallback === UNCLASSIFIED_CLIENT_LABEL ? UNKNOWN_SCOPE_LABEL : fallback;
  if (isUnclassifiedClient(customer)) return safeFallback;
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  if (name && !isPlaceholderClientLabel(normalizedClientKey(name)) && !isDatasourceLikeLabel(normalizedClientKey(name))) {
    return name;
  }
  if (key && !isPlaceholderClientLabel(normalizedClientKey(key)) && !isDatasourceLikeLabel(normalizedClientKey(key))) {
    return key;
  }
  return safeFallback;
}

/** Valor de host inválido/placeholder — não deve aparecer na UI. */
export function isMissingHostLabel(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (text === "-" || /^host$/i.test(text)) return true;
  if (/^host protegido\b/i.test(text)) return true;
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return (
    normalized === "host nao informado"
    || normalized === "host nao identificado"
    || normalized === "host nao disponivel"
  );
}

/**
 * Host canônico (OV-P0-40):
 * host_visible_name → host_technical_name → host_name → "Host não informado"
 * Remove placeholder "Host protegido" da interface.
 */
export function canonicalHostName(host?: HostIdentityFields | null, fallback = MISSING_HOST_LABEL) {
  for (const candidate of [host?.host_visible_name, host?.host_technical_name, host?.host_name]) {
    const value = String(candidate || "").trim();
    if (value && !isMissingHostLabel(value)) return value;
  }
  return fallback;
}

/** Campo individual de host (drawer técnico) — sem "Host protegido". */
export function displayHostField(value?: string | null, fallback = "Não informado") {
  const text = String(value || "").trim();
  if (!text || isMissingHostLabel(text)) return fallback;
  return text;
}

export function clientLogoSrc(customer?: ClientIdentityCustomer | null) {
  if (isAllCustomersSelection(customer)) return TELETEX_LOGO_SRC;
  if (isUnclassifiedClient(customer)) return null;
  const normalized = normalizedClientKey(customer?.key, customer?.name);
  if (!normalized || isDatasourceLikeLabel(normalized)) return null;
  return CUSTOMER_LOGO_CATALOG.find((item) => item.aliases.some((alias) => normalized.includes(alias)))?.src ?? null;
}

function clientInitials(customer?: ClientIdentityCustomer | null) {
  const source = canonicalClientName(customer, "CL");
  if (source === UNCLASSIFIED_CLIENT_LABEL || source === UNKNOWN_SCOPE_LABEL) return "CL";
  return source
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "CL";
}

type ClientIdentityProps = {
  customer?: ClientIdentityCustomer | null;
  /** OV-P0-56 — escopo operacional do BFF (sem inferência no FE). */
  operationalScope?: string | null;
  operationalScopeLabel?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  showName?: boolean;
  className?: string;
  nameClassName?: string;
};

export function ClientIdentity({
  customer,
  operationalScope,
  operationalScopeLabel,
  size = "sm",
  showName = false,
  className,
  nameClassName,
}: ClientIdentityProps) {
  const scope = normalizeOperationalScope(operationalScope ?? (customer as OperationalScopeFields | null)?.operational_scope);
  const scopedCustomer: ClientIdentityCustomer & OperationalScopeFields = {
    ...(customer || {}),
    operational_scope: scope,
    operational_scope_label: operationalScopeLabel
      ?? (customer as OperationalScopeFields | null)?.operational_scope_label
      ?? null,
  };
  // HOTFIX-P0-CLIENT-LABEL: cliente real → nome/logo; scope_label só sem customer.
  const hasRealCustomer = !isUnclassifiedClient(customer);
  const logo = hasRealCustomer ? clientLogoSrc(customer) : null;
  const explicitScopeLabel = String(operationalScopeLabel || scopedCustomer.operational_scope_label || "").trim();
  const name = hasRealCustomer
    ? canonicalClientName(customer)
    : (explicitScopeLabel || operationalClientLabel(scopedCustomer));
  // OV-P0-78: listas = 32px (sm); filtro = xs; drawer = md/lg.
  const box = size === "lg"
    ? "h-14 w-14"
    : size === "md"
      ? "h-11 w-11"
      : size === "xs"
        ? "h-6 w-6"
        : "h-8 w-8";
  const initialsSize = size === "xs" ? "text-[8px]" : "text-[10px]";
  const initials = hasRealCustomer
    ? clientInitials(customer)
    : (scope === "platform" || explicitScopeLabel === PLATFORM_SCOPE_LABEL
      ? "IN"
      : scope === "test" || explicitScopeLabel === TEST_SCOPE_LABEL
        ? "TS"
        : "CL");

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {logo ? (
        <img
          src={logo}
          alt={name}
          className={cn(
            box,
            "shrink-0 rounded-md border border-border/40 bg-white object-contain p-0.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]",
          )}
          loading="lazy"
        />
      ) : (
        <span
          className={cn(
            box,
            initialsSize,
            "flex shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/40 font-semibold uppercase text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {initials}
        </span>
      )}
      {showName ? (
        <span className={cn("min-w-0 truncate text-sm font-semibold text-foreground", nameClassName)}>
          {name}
        </span>
      ) : null}
    </span>
  );
}
