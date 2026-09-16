import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { getStoredTheme, setStoredTheme, type Theme } from "@/lib/settings";
import { prefetchOneViewRoute } from "@/lib/oneview-route-prefetch";
import { ONEVIEW_ICON_MAP, type OneViewIconName } from "@/lib/oneview-icons";
const MONITOR_SIDEBAR_STORAGE_KEY = "oneview-monitor-sidebar-open";

const SIDEBAR_ICON_SLOT = "flex h-10 w-14 shrink-0 items-center justify-center";
const SIDEBAR_LABEL = "pointer-events-none flex min-w-0 flex-1 items-center pr-3 opacity-0 transition-[opacity,transform] duration-150 -translate-x-1 group-hover/sidebar:pointer-events-auto group-hover/sidebar:translate-x-0 group-hover/sidebar:opacity-100 group-focus-within/sidebar:pointer-events-auto group-focus-within/sidebar:translate-x-0 group-focus-within/sidebar:opacity-100";
const SIDEBAR_LABEL_TEXT = "truncate text-sm leading-none";
const SIDEBAR_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-border focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar";
const SIDEBAR_ACTIVE_BAR =
  "before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-full before:bg-sidebar-foreground/80 before:opacity-0 before:transition-opacity";
const SIDEBAR_PROFILE_LABEL =
  "pointer-events-none flex min-w-0 max-h-0 flex-1 flex-col items-start gap-1 overflow-hidden pr-3 opacity-0 transition-[opacity,transform,max-height] duration-150 -translate-x-1 group-hover/sidebar:pointer-events-auto group-hover/sidebar:max-h-14 group-hover/sidebar:translate-x-0 group-hover/sidebar:opacity-100 group-focus-within/sidebar:pointer-events-auto group-focus-within/sidebar:max-h-14 group-focus-within/sidebar:translate-x-0 group-focus-within/sidebar:opacity-100";

type SidebarProps = {
  /**
   * Exclusivo de /monitoramento (OV-P0-38): permite recolher a largura zero
   * e persiste o estado em sessionStorage. Home/Alertas/Histórico não usam.
   */
  monitoringCollapse?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type NavItem = {
  name: string;
  href: string;
  icon: OneViewIconName;
  secondary?: string;
  liveDot?: boolean;
  iconClassName?: string;
};

// OV-P0-18/19/20: /config fora da lista principal; atalho no rodapé (acima do perfil).
const baseNavigation: NavItem[] = [
  { name: "Início", href: "/", icon: "home" },
  { name: "Monitoramento", href: "/monitoramento", icon: "monitoring", liveDot: true },
  { name: "Alertas", href: "/alertas", icon: "alerts", secondary: "Fila operacional" },
  { name: "Histórico", href: "/historico", icon: "history", secondary: "Eventos e ações" },
  { name: "Chamados", href: "/chamados", icon: "incidents", secondary: "ServiceNow" },
  { name: "Links", href: "/operadoras", icon: "links", secondary: "Conectividade" },
];

function navToneClasses(isActive: boolean) {
  if (!isActive) {
    return {
      item: "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      icon: "text-sidebar-foreground/60 group-hover/link:text-sidebar-accent-foreground",
      label: "text-sidebar-foreground/65 group-hover/link:text-sidebar-accent-foreground",
      secondary: "text-sidebar-foreground/45",
    };
  }

  return {
    item: "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent",
    icon: "text-sidebar-accent-foreground",
    label: "text-sidebar-accent-foreground",
    secondary: "text-sidebar-accent-foreground/65",
  };
}

function readMonitorSidebarOpen(): boolean {
  try {
    const raw = sessionStorage.getItem(MONITOR_SIDEBAR_STORAGE_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    // sessionStorage pode estar indisponível.
  }
  return true;
}

function writeMonitorSidebarOpen(open: boolean) {
  try {
    sessionStorage.setItem(MONITOR_SIDEBAR_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

function SidebarNavItem({
  name,
  to,
  icon,
  secondary,
  liveDot,
  iconClassName,
  end,
}: {
  name: string;
  to: string;
  icon: OneViewIconName;
  secondary?: string;
  liveDot?: boolean;
  iconClassName?: string;
  end?: boolean;
}) {
  const Icon = ONEVIEW_ICON_MAP[icon];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={to}
          onMouseEnter={() => prefetchOneViewRoute(to)}
          onFocus={() => prefetchOneViewRoute(to)}
          onPointerDown={() => prefetchOneViewRoute(to, { dataImmediate: true })}
          end={end}
          title={name}
          aria-label={secondary ? `${name}. ${secondary}` : name}
          className={({ isActive }) => {
            const tones = navToneClasses(isActive);
            return cn(
              "group/link relative flex min-h-10 w-full items-center overflow-hidden rounded-lg py-1 text-left transition-colors",
              SIDEBAR_ACTIVE_BAR,
              SIDEBAR_FOCUS_RING,
              isActive && "before:opacity-100",
              tones.item,
            );
          }}
        >
          {({ isActive }) => {
            const tones = navToneClasses(isActive);
            return (
              <>
                <span className={cn(SIDEBAR_ICON_SLOT, "relative")}>
                  <Icon className={cn("h-4 w-4 shrink-0 transition-colors", tones.icon, iconClassName)} />
                  {liveDot ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute right-3 top-1.5 h-1.5 w-1.5 rounded-full",
                        isActive ? "bg-success" : "bg-success/70",
                      )}
                    />
                  ) : null}
                </span>
                <span className={SIDEBAR_LABEL}>
                  <span className={cn(SIDEBAR_LABEL_TEXT, isActive ? "font-semibold" : "font-medium", tones.label)}>
                    {name}
                  </span>
                </span>
              </>
            );
          }}
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="group-hover/sidebar:hidden group-focus-within/sidebar:hidden">
        <p>{name}</p>
        {secondary ? <p className="text-xs text-muted-foreground">{secondary}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  monitoringCollapse = false,
  open: controlledOpen,
  onOpenChange,
}: SidebarProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => (
    monitoringCollapse ? readMonitorSidebarOpen() : true
  ));
  const [profilePhotoFailed, setProfilePhotoFailed] = useState(false);
  const [theme, setTheme] = useState<Theme>(getStoredTheme());
  const { user, logout } = useAuth();
  const displayUser = user;

  const isControlled = typeof controlledOpen === "boolean";
  const navOpen = monitoringCollapse
    ? (isControlled ? controlledOpen : uncontrolledOpen)
    : true;

  const setNavOpen = (next: boolean) => {
    if (!monitoringCollapse) return;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    setStoredTheme(nextTheme);
    setTheme(nextTheme);
  };

  useEffect(() => {
    if (!monitoringCollapse) return;
    writeMonitorSidebarOpen(navOpen);
  }, [monitoringCollapse, navOpen]);

  useEffect(() => {
    setProfilePhotoFailed(false);
  }, [displayUser?.photo]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "oneview_theme") setTheme(getStoredTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const initials = useMemo(() => {
    if (!displayUser?.name && !displayUser?.email) return "--";
    const source = displayUser?.name || displayUser?.email || "";
    const letters = source
      .split(" ")
      .map((part) => part.trim()[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("");
    return letters.toUpperCase();
  }, [displayUser?.name, displayUser?.email]);

  const themeLabel = theme === "light" ? "Ativar modo escuro" : "Ativar modo claro";
  const ThemeIcon = theme === "light" ? ONEVIEW_ICON_MAP.themeDark : ONEVIEW_ICON_MAP.themeLight;
  const CollapseIcon = ONEVIEW_ICON_MAP.sidebarCollapse;
  const ExpandIcon = ONEVIEW_ICON_MAP.sidebarExpand;

  if (monitoringCollapse && !navOpen) {
    return (
      <button
        type="button"
        onClick={() => setNavOpen(true)}
        className={cn(
          "fixed left-0 top-1/2 z-50 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-border/70 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:w-5 hover:text-foreground",
          SIDEBAR_FOCUS_RING,
        )}
        aria-label="Abrir navegação do monitoramento"
        title="Abrir navegação"
        data-monitor-sidebar="collapsed"
      >
        <ExpandIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      className="group/sidebar fixed inset-y-0 left-0 z-40 flex h-dvh max-h-dvh w-14 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width,box-shadow] duration-200 ease-out hover:w-60 hover:shadow-xl focus-within:w-60 focus-within:shadow-xl"
      data-monitor-sidebar={monitoringCollapse ? "open" : undefined}
    >
      <div className="relative flex h-14 shrink-0 items-center border-b border-sidebar-border">
        <div className="flex h-full min-w-0 flex-1 items-center">
          <span className={cn(SIDEBAR_ICON_SLOT, "h-14")}>
            <img
              src="/tltx/tltx-t-branco.png?v=4"
              alt="TLTX"
              width={28}
              height={28}
              className="h-[28px] w-[28px] shrink-0 select-none object-contain"
              draggable={false}
            />
          </span>
          <span className={SIDEBAR_LABEL}>
            <span className={cn(SIDEBAR_LABEL_TEXT, "font-semibold text-sidebar-foreground")}>OneView</span>
          </span>
        </div>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-y-auto overflow-x-hidden py-3"
        aria-label="Navegação operacional"
      >
        {baseNavigation.map((item) => (
          <SidebarNavItem
            key={item.name}
            name={item.name}
            to={item.href}
            icon={item.icon}
            secondary={item.secondary}
            liveDot={item.liveDot}
            iconClassName={item.iconClassName}
            end={item.href === "/"}
          />
        ))}
      </nav>

      <div className="shrink-0 space-y-1 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={themeLabel}
              aria-pressed={theme === "dark"}
              className={cn(
                "group/link flex min-h-10 w-full items-center rounded-lg py-1 text-left text-sidebar-foreground/65 transition-colors",
                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                SIDEBAR_FOCUS_RING,
              )}
            >
              <span className={SIDEBAR_ICON_SLOT}>
                <ThemeIcon className="h-4 w-4 shrink-0" />
              </span>
              <span className={SIDEBAR_LABEL}>
                <span className={cn(SIDEBAR_LABEL_TEXT, "font-medium")}>
                  {theme === "light" ? "Modo escuro" : "Modo claro"}
                </span>
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="group-hover/sidebar:hidden group-focus-within/sidebar:hidden">
            <p>{themeLabel}</p>
          </TooltipContent>
        </Tooltip>

        <SidebarNavItem name="Configurações" to="/config" icon="settings" />
      </div>

      <div className="shrink-0 border-t border-sidebar-border px-0 pb-2 pt-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex w-full items-start">
              <div className={cn(SIDEBAR_ICON_SLOT, "h-8")}>
                <span className="relative flex h-8 w-8 aspect-square items-center justify-center overflow-hidden rounded-full border border-sidebar-border bg-sidebar-accent text-[10px] font-semibold uppercase text-sidebar-accent-foreground">
                  {displayUser?.photo && !profilePhotoFailed ? (
                    <img
                      src={displayUser.photo}
                      alt=""
                      className="h-full w-full object-cover"
                      onError={() => setProfilePhotoFailed(true)}
                    />
                  ) : <span>{initials}</span>}
                </span>
              </div>
              <div className={SIDEBAR_PROFILE_LABEL}>
                <span className={cn(SIDEBAR_LABEL_TEXT, "block h-8 leading-8 font-semibold text-sidebar-foreground")}>
                  {displayUser?.name ?? "Usuário"}
                </span>
                <button
                  type="button"
                  onClick={() => void logout()}
                  disabled={!displayUser}
                  aria-label="Sair"
                  className={cn(
                    "block text-left text-[10px] font-medium leading-none text-sidebar-foreground/50 transition-colors",
                    "hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-40",
                    SIDEBAR_FOCUS_RING,
                  )}
                >
                  Sair
                </button>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="group-hover/sidebar:hidden group-focus-within/sidebar:hidden">
            {displayUser ? (
              <p className="text-sm font-semibold">{displayUser.name}</p>
            ) : <p>Não autenticado</p>}
          </TooltipContent>
        </Tooltip>
      </div>

      {monitoringCollapse ? (
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          className={cn(
            "absolute right-0 top-1/2 z-50 flex h-10 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground/70 shadow-sm transition-colors hover:text-sidebar-foreground",
            SIDEBAR_FOCUS_RING,
          )}
          aria-label="Recolher navegação do monitoramento"
          title="Recolher navegação"
        >
          <CollapseIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </aside>
  );
}
