import { cn } from "@/lib/utils";

export type ClientIdentityCustomer = {
  key?: string | null;
  name?: string | null;
  /** `customer_source` do alerta, quando disponível. */
  source?: string | null;
};

export type HostIdentityFields = {
  host_visible_name?: string | null;
  host_technical_name?: string | null;
  host_name?: string | null;
};

export const UNCLASSIFIED_CLIENT_LABEL = "Cliente não classificado";
export const MISSING_HOST_LABEL = "Host não informado";

const TELETEX_LOGO_SRC = "/tltx/clientes/logos/teletex-logo.png";

const CUSTOMER_LOGO_CATALOG = [
  { aliases: ["ailos"], src: "/tltx/clientes/logos/Ailos.png" },
  { aliases: ["alubauen"], src: "/tltx/clientes/logos/alubauen-logo.png" },
  { aliases: ["arauco"], src: "/tltx/clientes/logos/arauco-logo.png" },
  { aliases: ["berneck"], src: "/tltx/clientes/logos/berneck-logo.png" },
  { aliases: ["bnb", "banco do nordeste"], src: "/tltx/clientes/logos/bnb-logo.png" },
  { aliases: ["brinks"], src: "/tltx/clientes/logos/brinks-logo.png" },
  { aliases: ["castrolanda"], src: "/tltx/clientes/logos/castrolanda-logo.png" },
  { aliases: ["ciser"], src: "/tltx/clientes/logos/ciser-logo.png" },
  { aliases: ["copel"], src: "/tltx/clientes/logos/copel-logo.png" },
  { aliases: ["essentia"], src: "/tltx/clientes/logos/essentia-logo.png" },
  { aliases: ["estacio"], src: "/tltx/clientes/logos/estacio-logo.png" },
  { aliases: ["fps"], src: "/tltx/clientes/logos/fps-logo.png" },
  { aliases: ["fraport"], src: "/tltx/clientes/logos/fraport-logo.png" },
  { aliases: ["havan"], src: "/tltx/clientes/logos/havan-logo.png" },
  { aliases: ["nissan"], src: "/tltx/clientes/logos/nissan-logo.png" },
  { aliases: ["ntn"], src: "/tltx/clientes/logos/ntn-logo.png" },
  { aliases: ["osasco"], src: "/tltx/clientes/logos/osasco-logo.png" },
  { aliases: ["sanepar"], src: "/tltx/clientes/logos/sanepar.png" },
  { aliases: ["sapore"], src: "/tltx/clientes/logos/sapore-logo.png" },
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
  fallback = UNCLASSIFIED_CLIENT_LABEL,
) {
  if (isUnclassifiedClient(customer)) return fallback;
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  if (name && !isPlaceholderClientLabel(normalizedClientKey(name)) && !isDatasourceLikeLabel(normalizedClientKey(name))) {
    return name;
  }
  if (key && !isPlaceholderClientLabel(normalizedClientKey(key)) && !isDatasourceLikeLabel(normalizedClientKey(key))) {
    return key;
  }
  return fallback;
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
  if (source === UNCLASSIFIED_CLIENT_LABEL) return "CL";
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
  size?: "sm" | "md";
  showName?: boolean;
  className?: string;
  nameClassName?: string;
};

export function ClientIdentity({
  customer,
  size = "sm",
  showName = false,
  className,
  nameClassName,
}: ClientIdentityProps) {
  const logo = clientLogoSrc(customer);
  const name = canonicalClientName(customer);
  const box = size === "md" ? "h-10 w-10" : "h-8 w-8";

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {logo ? (
        <img
          src={logo}
          alt={name}
          className={cn(
            box,
            "shrink-0 rounded-md border border-border/40 bg-white object-contain p-1 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]",
          )}
          loading="lazy"
        />
      ) : (
        <span
          className={cn(
            box,
            "flex shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/40 text-[10px] font-semibold uppercase text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {clientInitials(customer)}
        </span>
      )}
      {showName ? (
        <span className={cn("min-w-0 truncate text-sm font-medium text-foreground", nameClassName)}>
          {name}
        </span>
      ) : null}
    </span>
  );
}
