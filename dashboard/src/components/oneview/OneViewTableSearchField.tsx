import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Check,
  FileText,
  Hash,
  Link2,
  Loader2,
  Plus,
  Search,
  Server,
  User,
} from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { normalizeIncSearchDraft } from "@/lib/oneview-chamados-search";
import {
  createOneViewSearchCommitter,
  ONEVIEW_SEARCH_COMMIT_DEBOUNCE_MS,
  ONEVIEW_SEARCH_SUGGEST_DEBOUNCE_MS,
} from "@/lib/oneview-search-commit";
import type { OneViewSearchSuggestion } from "@/lib/oneview-api";
import { cn } from "@/lib/utils";

export type OneViewTableSearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onSelect?: (value: string) => void;
  onSuggestionSelect?: (item: OneViewSearchSuggestion) => void;
  placeholder: string;
  ariaLabel: string;
  inputId?: string;
  className?: string;
  normalizeInc?: boolean;
  fetchSuggestions?: (query: string, signal: AbortSignal) => Promise<OneViewSearchSuggestion[]>;
  activity?: "idle" | "pending" | "searching";
  activityQuery?: string;
  localSuggestions?: OneViewSearchSuggestion[];
  getSuggestionActionLabel?: (item: OneViewSearchSuggestion) => string | null;
  isSuggestionSelected?: (item: OneViewSearchSuggestion) => boolean;
};

const MIN_QUERY_LENGTH = 2;
const CACHE_MAX = 64;
const CACHE_TTL_MS = 30_000;
const MAX_VISIBLE_SUGGESTIONS = 15;

type CachedSuggestions = { items: OneViewSearchSuggestion[]; storedAt: number };

function normalizeSuggestionText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

function suggestionKey(item: OneViewSearchSuggestion) {
  return `${item.kind || "description"}:${item.customer_key || ""}:${normalizeSuggestionText(item.value || item.label)}`;
}

function localSuggestionRank(item: OneViewSearchSuggestion, query: string) {
  const label = normalizeSuggestionText(item.label || item.value);
  const value = normalizeSuggestionText(item.value);
  if (label === query || value === query) return 0;
  if (label.startsWith(query) || value.startsWith(query)) return 1;
  if (label.includes(query) || value.includes(query)) return 2;
  return Number.POSITIVE_INFINITY;
}

function mergeSuggestions(local: OneViewSearchSuggestion[], remote: OneViewSearchSuggestion[]) {
  const seen = new Set<string>();
  return [...local, ...remote].filter((item) => {
    const key = suggestionKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_VISIBLE_SUGGESTIONS);
}

function defaultSuggestionAction(item: OneViewSearchSuggestion) {
  if (item.kind === "customer" || item.kind === "company") return "Aplicar Cliente";
  if (item.kind === "host") return "Aplicar Host";
  if (item.kind === "number") return "Aplicar Chamado";
  if (item.kind === "link") return "Aplicar Link";
  return "Pesquisar";
}

/** Shared main-search commit policy. Keeps typing local until debounce or Enter. */
export function useOneViewCommittedSearch(
  value: string,
  onCommit: (value: string) => void,
  delay = ONEVIEW_SEARCH_COMMIT_DEBOUNCE_MS,
) {
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const committerRef = useRef<ReturnType<typeof createOneViewSearchCommitter> | null>(null);
  if (!committerRef.current) {
    committerRef.current = createOneViewSearchCommitter({
      delay,
      onCommit: (next) => commitRef.current(next),
      schedule: (callback, wait) => window.setTimeout(callback, wait),
      clear: (timer) => window.clearTimeout(timer as number),
    });
  }
  const cancelPending = useCallback(() => committerRef.current?.cancel(), []);
  const commitNow = useCallback((next = value) => committerRef.current?.commitNow(next), [value]);

  useEffect(() => {
    committerRef.current?.schedule(value);
    return cancelPending;
  }, [cancelPending, delay, value]);

  return { commitNow, cancelPending };
}

const GROUP_ORDER = ["customer", "company", "host", "link", "problem", "number", "description", "actor", "event"];

const GROUP_LABELS: Record<string, string> = {
  number: "Chamados",
  company: "Clientes",
  customer: "Clientes",
  description: "Descrições",
  host: "Hosts",
  problem: "Problemas",
  actor: "Atores",
  link: "Links",
  event: "Eventos",
};

const KIND_ICONS: Record<string, typeof Hash> = {
  number: Hash,
  company: Building2,
  customer: Building2,
  description: FileText,
  host: Server,
  problem: FileText,
  actor: User,
  link: Link2,
};

const DEFAULT_HINT: Record<string, string> = {
  customer: "Filtrar tabela por cliente",
  company: "Filtrar tabela por cliente",
  host: "Filtrar tabela por host",
  problem: "Filtrar tabela por problema",
  link: "Filtrar tabela por link",
  number: "Filtrar pelo número do chamado",
  description: "Filtrar tabela por descrição",
};

function HighlightLabel({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <span className="truncate font-semibold">{text}</span>;

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "i"));
  if (parts.length < 2) return <span className="truncate font-semibold">{text}</span>;

  return (
    <span className="truncate font-semibold">
      {parts.map((part, index) => (
        index % 2 === 1
          ? <span key={index} className="rounded-sm bg-primary/20">{part}</span>
          : <span key={index}>{part}</span>
      ))}
    </span>
  );
}

function groupByKindOrdered(items: OneViewSearchSuggestion[]) {
  const groups = new Map<string, OneViewSearchSuggestion[]>();
  for (const item of items) {
    const key = item.kind || "description";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return GROUP_ORDER
    .filter((kind) => groups.has(kind))
    .map((kind) => [kind, groups.get(kind)!] as const);
}

export function OneViewTableSearchField({
  value,
  onChange,
  onSubmit,
  onSelect,
  onSuggestionSelect,
  placeholder,
  ariaLabel,
  inputId,
  className,
  normalizeInc = true,
  fetchSuggestions,
  activity = "idle",
  activityQuery,
  localSuggestions = [],
  getSuggestionActionLabel,
  isSuggestionSelected,
}: OneViewTableSearchFieldProps) {
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [remoteSuggestions, setRemoteSuggestions] = useState<OneViewSearchSuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef(new Map<string, CachedSuggestions>());
  const fetchRef = useRef(fetchSuggestions);
  fetchRef.current = fetchSuggestions;
  const remoteSuggestionsEnabled = typeof fetchSuggestions === "function";
  const suggestionsEnabled = remoteSuggestionsEnabled || localSuggestions.length > 0;

  useEffect(() => {
    abortRef.current?.abort();
    cacheRef.current.clear();
    setRemoteSuggestions([]);
  }, [fetchSuggestions]);

  useEffect(() => {
    const trimmed = value.trim();
    if (!remoteSuggestionsEnabled || !focused || trimmed.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      setLoading(false);
      if (!focused || trimmed.length < MIN_QUERY_LENGTH) setRemoteSuggestions([]);
      return;
    }

    const cacheKey = trimmed.toLowerCase();
    const cached = cacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
      setRemoteSuggestions(cached.items);
      setLoading(false);
      return;
    }

    if (cached) {
      setRemoteSuggestions(cached.items);
    } else {
      const prefix = [...cacheRef.current.entries()]
        .filter(([key]) => cacheKey.startsWith(key))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1];
      if (prefix) {
        const needle = normalizeSuggestionText(trimmed);
        setRemoteSuggestions(prefix.items.filter((item) => (
          normalizeSuggestionText(item.label).includes(needle)
          || normalizeSuggestionText(item.value).includes(needle)
        )));
      }
    }

    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      fetchRef.current(trimmed, controller.signal)
        .then((items) => {
          if (controller.signal.aborted) return;
          cacheRef.current.set(cacheKey, { items, storedAt: Date.now() });
          if (cacheRef.current.size > CACHE_MAX) {
            const first = cacheRef.current.keys().next().value;
            if (first) cacheRef.current.delete(first);
          }
          setRemoteSuggestions(items);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          if (!cached) setRemoteSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, ONEVIEW_SEARCH_SUGGEST_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [focused, remoteSuggestionsEnabled, value]);

  const trimmed = value.trim();
  const showPopover = suggestionsEnabled && focused && trimmed.length >= MIN_QUERY_LENGTH;
  const localMatches = useMemo(() => {
    const query = normalizeSuggestionText(trimmed);
    if (query.length < MIN_QUERY_LENGTH) return [];
    return localSuggestions
      .map((item) => ({ item, rank: localSuggestionRank(item, query) }))
      .filter(({ rank }) => Number.isFinite(rank))
      .sort((left, right) => left.rank - right.rank || left.item.label.localeCompare(right.item.label, "pt-BR"))
      .map(({ item }) => item);
  }, [localSuggestions, trimmed]);
  const suggestions = useMemo(() => mergeSuggestions(localMatches, remoteSuggestions), [localMatches, remoteSuggestions]);
  const grouped = useMemo(() => groupByKindOrdered(suggestions), [suggestions]);
  const orderedSuggestions = useMemo(() => grouped.flatMap(([, items]) => items), [grouped]);

  useEffect(() => {
    setActiveSuggestionIndex(orderedSuggestions.length ? 0 : -1);
  }, [trimmed, orderedSuggestions]);
  const activityLabel = activity === "pending"
    ? "Preparando busca…"
    : activity === "searching"
      ? `Buscando por “${activityQuery?.trim() || trimmed}”…`
      : null;

  function handleChange(nextRaw: string) {
    onChange(normalizeInc ? normalizeIncSearchDraft(nextRaw) : nextRaw);
  }

  function pickSuggestion(item: OneViewSearchSuggestion) {
    if (onSuggestionSelect) onSuggestionSelect(item);
    else if (onSelect) onSelect(item.value);
    else onChange(item.value);
    setActiveSuggestionIndex(-1);
    setFocused(false);
  }

  function pickFreeText() {
    if (onSubmit) onSubmit(trimmed);
    else if (onSelect) onSelect(trimmed);
    else onChange(trimmed);
    setFocused(false);
  }

  return (
    <Popover open={showPopover}>
      <PopoverAnchor asChild>
        <label className={cn("relative min-w-[15rem] flex-1", className)}>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            value={value}
            onChange={(event) => handleChange(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              window.setTimeout(() => setFocused(false), 100);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && showPopover && orderedSuggestions.length) {
                event.preventDefault();
                setActiveSuggestionIndex((current) => Math.min(orderedSuggestions.length - 1, current + 1));
                return;
              }
              if (event.key === "ArrowUp" && showPopover && orderedSuggestions.length) {
                event.preventDefault();
                setActiveSuggestionIndex((current) => Math.max(0, current <= 0 ? orderedSuggestions.length - 1 : current - 1));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const activeSuggestion = orderedSuggestions[activeSuggestionIndex];
                if (showPopover && activeSuggestion) pickSuggestion(activeSuggestion);
                else pickFreeText();
              }
              if (event.key === "Escape") setFocused(false);
            }}
            placeholder={placeholder}
            className={cn("h-9 pl-9", activityLabel && "pr-36 sm:pr-48")}
            aria-label={ariaLabel}
            aria-expanded={showPopover}
            autoComplete="off"
          />
          {activityLabel ? (
            <span aria-live="polite" className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 rounded-full bg-muted/90 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm">
              <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin text-primary" />
              <span className="hidden sm:inline">{activityLabel}</span>
              <span className="sm:hidden">Buscando…</span>
            </span>
          ) : loading && trimmed.length >= MIN_QUERY_LENGTH ? (
            <Loader2
              aria-hidden="true"
              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
            />
          ) : null}
        </label>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[min(28rem,var(--radix-popover-trigger-width))] min-w-[var(--radix-popover-trigger-width)] p-0 sm:w-[min(32rem,90vw)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList className="max-h-80">
            <CommandGroup heading="Pesquisar">
              <CommandItem
                value={`search-all-${trimmed}`}
                onMouseDown={(event) => event.preventDefault()}
                onSelect={pickFreeText}
                className="gap-2 py-2 data-[selected=true]:!bg-muted data-[selected=true]:!text-foreground"
              >
                <Search className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-xs">
                  Pesquisar por «<span className="font-semibold">{trimmed}</span>»
                </span>
              </CommandItem>
            </CommandGroup>
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Carregando sugestões…
              </div>
            ) : null}
            {!loading && suggestions.length === 0 ? (
              <CommandEmpty className="px-3 py-2 text-xs text-muted-foreground">
                Nenhum cliente ou host com esse texto nos filtros atuais. Use Enter para buscar na tabela.
              </CommandEmpty>
            ) : null}
            {grouped.map(([kind, items], groupIndex) => {
              const Icon = KIND_ICONS[kind] ?? FileText;
              return (
                <div key={kind}>
                  {groupIndex > 0 || !loading ? <CommandSeparator /> : null}
                  <CommandGroup heading={GROUP_LABELS[kind] ?? kind}>
                    {items.map((item) => {
                      const itemIndex = orderedSuggestions.findIndex((candidate) => suggestionKey(candidate) === suggestionKey(item));
                      const selected = isSuggestionSelected?.(item) ?? false;
                      const isClient = kind === "customer" || kind === "company";
                      const actionLabel = selected
                        ? "Selecionado"
                        : getSuggestionActionLabel?.(item) ?? defaultSuggestionAction(item);
                      return (
                      <CommandItem
                        key={`${kind}-${item.value}`}
                        value={item.value}
                        aria-label={`${isClient ? "Cliente" : GROUP_LABELS[kind] ?? kind}: ${item.label}. ${actionLabel}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveSuggestionIndex(itemIndex)}
                        onSelect={() => pickSuggestion(item)}
                        className={cn(
                          "gap-2 rounded-md border border-transparent py-2.5 data-[selected=true]:!bg-muted data-[selected=true]:!text-foreground",
                          itemIndex === activeSuggestionIndex && "!border-border !bg-muted !text-foreground",
                        )}
                      >
                        <span className={cn(
                          "grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground",
                          isClient && "border-primary/20 bg-primary/10 text-primary",
                        )}>
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          {isClient ? (
                            <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                              Cliente
                            </span>
                          ) : null}
                          <span className="block min-w-0">
                            <HighlightLabel text={item.label} query={trimmed} />
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {item.hint || DEFAULT_HINT[kind] || "Filtrar tabela"}
                            {item.company && kind === "number" ? ` · ${item.company}` : null}
                          </span>
                        </span>
                        <span className={cn(
                          "ml-2 inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[10px] font-bold",
                          selected ? "border-primary/30 text-primary" : "text-foreground",
                        )}>
                          {selected ? <Check className="h-3 w-3" aria-hidden="true" /> : isClient ? <Plus className="h-3 w-3" aria-hidden="true" /> : null}
                          {actionLabel}
                        </span>
                      </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </div>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
