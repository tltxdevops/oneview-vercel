import { Home, Bell, History, Monitor, ChevronLeft, ChevronRight, Ticket, Settings, LogOut, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { isServiceNowIncidentsUiEnabled } from "@/lib/servicenow-features";

const MONITOR_SIDEBAR_STORAGE_KEY = "oneview-monitor-sidebar-open";

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
  icon: LucideIcon;
  secondary?: string;
  liveDot?: boolean;
};

// OV-P0-18/19/20: /config fora da lista principal; atalho no rodapé (acima do perfil).
// SN-P0-07: /chamados só entra no menu com VITE_SERVICENOW_INCIDENTS_ENABLED=true.
const baseNavigation: NavItem[] = [
  { name: "Início", href: "/", icon: Home },
  { name: "Monitoramento", href: "/monitoramento", icon: Monitor, liveDot: true },
  { name: "Alertas", href: "/alertas", icon: Bell, secondary: "Fila operacional" },
  { name: "Histórico", href: "/historico", icon: History, secondary: "Eventos e ações" },
];

const chamadosNavItem: NavItem = {
  name: "Chamados",
  href: "/chamados",
  icon: Ticket,
  secondary: "ServiceNow",
};

function navToneClasses(isActive: boolean) {
  if (!isActive) {
    return {
      item: "text-white/55 hover:bg-white/5 hover:text-white",
      icon: "text-white/55 group-hover/link:text-white",
      label: "text-white/55 group-hover/link:text-white",
      secondary: "text-white/40",
    };
  }

  return {
    item: "bg-white/10 text-white",
    icon: "text-white",
    label: "text-white",
    secondary: "text-white/60",
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
  icon: Icon,
  secondary,
  liveDot,
  end,
}: {
  name: string;
  to: string;
  icon: LucideIcon;
  secondary?: string;
  liveDot?: boolean;
  end?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={to}
          end={end}
          aria-label={secondary ? `${name}. ${secondary}` : name}
          className={({ isActive }) => {
            const tones = navToneClasses(isActive);
            return cn(
              "group/link relative flex min-h-9 items-center rounded-xl px-1.5 py-1 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
              tones.item,
            );
          }}
        >
          {({ isActive }) => {
            const tones = navToneClasses(isActive);
            return (
              <>
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                  <Icon className={cn("h-4 w-4 shrink-0 transition-colors", tones.icon)} />
                  {liveDot ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full",
                        isActive ? "bg-emerald-300" : "bg-emerald-500/70",
                      )}
                    />
                  ) : null}
                </span>
                <span className="ml-2 min-w-0 flex-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <span className={cn("block truncate text-sm", isActive ? "font-semibold" : "font-medium", tones.label)}>
                    {name}
                  </span>
                </span>
              </>
            );
          }}
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="group-hover:hidden">
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

  useEffect(() => {
    if (!monitoringCollapse) return;
    writeMonitorSidebarOpen(navOpen);
  }, [monitoringCollapse, navOpen]);

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

  const navigation = useMemo(() => {
    if (!isServiceNowIncidentsUiEnabled()) return baseNavigation;
    const historicoIndex = baseNavigation.findIndex((item) => item.href === "/historico");
    if (historicoIndex < 0) return [...baseNavigation, chamadosNavItem];
    return [
      ...baseNavigation.slice(0, historicoIndex + 1),
      chamadosNavItem,
      ...baseNavigation.slice(historicoIndex + 1),
    ];
  }, []);

  if (monitoringCollapse && !navOpen) {
    return (
      <button
        type="button"
        onClick={() => setNavOpen(true)}
        className="fixed left-0 top-1/2 z-50 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-border/70 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:w-5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Abrir navegação do monitoramento"
        title="Abrir navegação"
        data-monitor-sidebar="collapsed"
      >
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      className="group fixed inset-y-0 left-0 z-40 flex h-dvh max-h-dvh w-14 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-linear hover:w-56"
      data-monitor-sidebar={monitoringCollapse ? "open" : undefined}
    >
      <div className="relative flex h-14 shrink-0 items-center justify-start border-b border-white/10 px-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-white/5">
            <img
              src="/tltx/tltx-t-branco.svg"
              alt="TLTX"
              className="h-5 w-5 select-none"
              draggable={false}
            />
          </span>
          <span className="hidden text-sm font-semibold text-white group-hover:inline-block">
            OneView
          </span>
        </div>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-y-auto overflow-x-hidden px-2.5 py-3"
        aria-label="Navegação operacional"
      >
        {navigation.map((item) => (
          <SidebarNavItem
            key={item.name}
            name={item.name}
            to={item.href}
            icon={item.icon}
            secondary={item.secondary}
            liveDot={item.liveDot}
            end={item.href === "/"}
          />
        ))}
      </nav>

      <div className="shrink-0 border-t border-white/10 px-2.5 py-3">
        <SidebarNavItem name="Configurações" to="/config" icon={Settings} />
      </div>

      <div className="shrink-0 space-y-1 border-t border-white/10 px-2.5 py-3">
        <div className="flex items-center gap-2.5 px-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="relative flex h-8 w-8 shrink-0 aspect-square items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/10 text-[11px] font-semibold uppercase text-white"
                aria-label={displayUser ? `Perfil (${displayUser.email})` : "Usuário não autenticado"}
              >
                {displayUser?.photo ? (
                  <img src={displayUser.photo} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span>{initials}</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="group-hover:hidden">
              {displayUser ? (
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold">{displayUser.name}</p>
                  <p className="text-xs text-muted-foreground/80">{displayUser.email}</p>
                </div>
              ) : (
                <p>Não autenticado</p>
              )}
            </TooltipContent>
          </Tooltip>

          <div className="hidden min-w-0 flex-1 flex-col group-hover:flex">
            <span className="truncate text-sm font-semibold text-white">
              {displayUser?.name ?? "Usuário"}
            </span>
            <span className="truncate text-xs text-white/55">
              {displayUser?.email ?? "sso@teletex.com"}
            </span>
          </div>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={logout}
              disabled={!displayUser}
              aria-label="Sair"
              className={cn(
                "group/link flex min-h-9 w-full items-center rounded-xl px-1.5 py-1 text-white/55 transition-colors",
                "hover:bg-white/5 hover:text-white",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                <LogOut className="h-4 w-4 shrink-0" />
              </span>
              <span className="ml-2 min-w-0 flex-1 truncate text-sm font-medium opacity-0 transition-opacity group-hover:opacity-100">
                Sair
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="group-hover:hidden">
            <p>Sair</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {monitoringCollapse ? (
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          className="absolute right-0 top-1/2 z-50 flex h-10 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-white/70 shadow-sm transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label="Recolher navegação do monitoramento"
          title="Recolher navegação"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </aside>
  );
}
