import { Home, Bell, History, Moon, Sun, Monitor, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

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

// OV-P0-18/19/20: /config fora do menu; estado ativo neutro (sem cor por rota).
const navigation: NavItem[] = [
  { name: "Início", href: "/", icon: Home },
  { name: "Monitoramento", href: "/monitoramento", icon: Monitor, liveDot: true },
  { name: "Alertas", href: "/alertas", icon: Bell, secondary: "Fila operacional" },
  { name: "Histórico", href: "/historico", icon: History, secondary: "Eventos e ações" },
];

function navToneClasses(isActive: boolean) {
  if (!isActive) {
    return {
      item: "text-white/65 hover:bg-white/5 hover:text-white",
      marker: "bg-transparent",
      icon: "text-white/65 group-hover/link:text-white",
      label: "text-white/70 group-hover/link:text-white",
      secondary: "text-white/40",
    };
  }

  return {
    item: "bg-white/15 text-white",
    marker: "bg-white",
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

export function Sidebar({
  monitoringCollapse = false,
  open: controlledOpen,
  onOpenChange,
}: SidebarProps) {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const storedTheme = window.localStorage.getItem("oneview-theme");
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
    return "light";
  });
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
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("oneview-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!monitoringCollapse) return;
    writeMonitorSidebarOpen(navOpen);
  }, [monitoringCollapse, navOpen]);

  const toggleTheme = () => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  };

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
      <div className="relative flex h-14 items-center justify-start border-b border-sidebar-border px-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full">
            <img
              src="/tltx/tltx-t-branco.svg"
              alt="TLTX"
              className="h-6 w-6 select-none"
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
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <Tooltip key={item.name}>
              <TooltipTrigger asChild>
                <NavLink
                  to={item.href}
                  end={item.href === "/"}
                  aria-label={item.secondary ? `${item.name}. ${item.secondary}` : item.name}
                  className={({ isActive }) => {
                    const tones = navToneClasses(isActive);
                    return cn(
                      "group/link relative flex min-h-9 items-center rounded-lg px-1.5 py-1 transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                      tones.item,
                    );
                  }}
                >
                  {({ isActive }) => {
                    const tones = navToneClasses(isActive);
                    return (
                      <>
                        <span
                          aria-hidden="true"
                          className={cn(
                            "absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-full transition-colors",
                            tones.marker,
                          )}
                        />
                        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                          <Icon className={cn("h-4 w-4 shrink-0 transition-colors", tones.icon)} />
                          {item.liveDot ? (
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
                            {item.name}
                          </span>
                          {item.secondary ? (
                            <span className={cn("mt-0.5 block truncate text-[11px]", tones.secondary)}>
                              {item.secondary}
                            </span>
                          ) : null}
                        </span>
                      </>
                    );
                  }}
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right" className="group-hover:hidden">
                <p>{item.name}</p>
                {item.secondary ? <p className="text-xs text-muted-foreground">{item.secondary}</p> : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      <div className="shrink-0 p-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleTheme}
              className="group/theme relative flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-sidebar-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              aria-label={theme === "light" ? "Ativar modo escuro" : "Ativar modo claro"}
            >
              {theme === "light" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
              <span className="absolute left-14 hidden whitespace-nowrap text-sm text-white/80 group-hover:inline-block">
                {theme === "light" ? "Modo escuro" : "Modo claro"}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="group-hover:hidden">
            <p>{theme === "light" ? "Ativar modo escuro" : "Ativar modo claro"}</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="p-3">
        <div className="flex items-center justify-start gap-3 pl-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={logout}
                className={cn(
                  "relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/10 text-sm font-semibold uppercase text-white transition hover:opacity-90",
                  !displayUser && "cursor-not-allowed opacity-70",
                )}
                aria-label={displayUser ? `Perfil (${displayUser.email})` : "Usuário não autenticado"}
                disabled={!displayUser}
              >
                {displayUser?.photo ? (
                  <img src={displayUser.photo} alt={displayUser.name} className="h-full w-full object-cover" />
                ) : (
                  <span>{initials}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="group-hover:hidden">
              {displayUser ? (
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{displayUser.name}</p>
                  <p className="text-xs text-muted-foreground/80">{displayUser.email}</p>
                  <button
                    onClick={logout}
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                  >
                    Sair
                  </button>
                </div>
              ) : (
                <p>Não autenticado</p>
              )}
            </TooltipContent>
          </Tooltip>

          <div className="hidden min-w-0 flex-1 flex-col text-white/90 group-hover:flex">
            <span className="truncate text-sm font-semibold">{displayUser?.name ?? "Usuário"}</span>
            <span className="truncate text-xs text-white/70">{displayUser?.email ?? "sso@teletex.com"}</span>
            <button
              type="button"
              onClick={logout}
              disabled={!displayUser}
              className="mt-2 w-fit text-xs font-medium text-white/80 underline-offset-2 hover:text-white hover:underline disabled:text-white/40"
            >
              Sair
            </button>
          </div>
        </div>
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
