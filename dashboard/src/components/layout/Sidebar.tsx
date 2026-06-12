import { Home, Bell, BarChart3, Ticket, FileText, Settings, ShieldCheck, Database, Monitor } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";

const navigation = [
  { name: "Home", href: "/", icon: Home },
  { name: "Alertas", href: "/alertas", icon: Bell },
  { name: "Banco de Dados", href: "/banco-dados", icon: Database },
  { name: "Certificados", href: "/certificados", icon: ShieldCheck },
  { name: "Workspaces", href: "/workspaces", icon: Monitor },
  { name: "KPIs", href: "/kpis", icon: BarChart3 },
  { name: "Chamados", href: "/chamados", icon: Ticket },
  { name: "Relatórios", href: "/relatorios", icon: FileText },
  { name: "Configurações", href: "/config", icon: Settings },
];

export function Sidebar() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const { user, logout } = useAuth();

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === "light" ? "dark" : "light";
    setTheme(newTheme);
    document.documentElement.classList.toggle("dark");
  };

  const initials = useMemo(() => {
    if (!user?.name && !user?.email) return "--";
    const source = user?.name || user?.email || "";
    const letters = source
      .split(" ")
      .map((part) => part.trim()[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("");
    return letters.toUpperCase();
  }, [user?.name, user?.email]);

  return (
    <aside className="group fixed left-0 top-0 z-40 h-screen w-20 hover:w-64 transition-[width] duration-200 ease-linear bg-sidebar border-r border-sidebar-border flex flex-col overflow-hidden">
      {/* Logo */}
      <div className="h-20 flex items-center border-b border-sidebar-border px-4 justify-start">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-12 h-12 rounded-full">
            <img
              src="/tltx/tltx-t-branco.svg"
              alt="TLTX"
              className="w-8 h-8 select-none"
              draggable={false}
            />
          </span>
          <span className="hidden group-hover:inline-block text-white font-semibold text-base">
            OneView
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-6 flex flex-col gap-4 items-start overflow-y-auto overflow-x-hidden px-4">
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <Tooltip key={item.name}>
              <TooltipTrigger asChild>
                <NavLink
                  to={item.href}
                  end={item.href === "/"}
                  className={({ isActive }) =>
                    cn(
                      "group/link relative flex items-center justify-center h-12 w-12 rounded-full transition-colors",
                      "text-white/70",
                      isActive ? "bg-sidebar-accent text-white" : "hover:bg-sidebar-accent/80 hover:text-white"
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-full transition-colors",
                          isActive && "bg-white/10"
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-5 w-5 transition-colors flex-shrink-0",
                            isActive
                              ? "text-white"
                              : "text-white/70 group-hover/link:text-white"
                          )}
                        />
                      </span>
                      <span
                        className={cn(
                          "absolute left-14 text-sm whitespace-nowrap opacity-0 transition-opacity",
                          "group-hover:opacity-100",
                          isActive ? "text-white" : "text-white/70 group-hover/link:text-white"
                        )}
                      >
                        {item.name}
                      </span>
                    </>
                  )}
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right" className="group-hover:hidden">
                <p>{item.name}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {/* Theme toggle moved to Settings page */}

      {/* User */}
      <div className="p-3 border-t border-sidebar-border">
        <div className="flex items-center gap-3 justify-start pl-1">
          <Tooltip>
              <TooltipTrigger asChild>
              <button
                onClick={logout}
                className={cn(
                  "relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/10 text-sm font-semibold uppercase text-white transition hover:opacity-90",
                  !user && "opacity-70 cursor-not-allowed"
                )}
                aria-label={user ? `Sair (${user.email})` : "Usuário não autenticado"}
                disabled={!user}
              >
                {user?.photo ? (
                  <img src={user.photo} alt={user.name} className="h-full w-full object-cover" />
                ) : (
                  <span>{initials}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="group-hover:hidden">
              {user ? (
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{user.name}</p>
                  <p className="text-xs text-muted-foreground/80">{user.email}</p>
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

          <div className="hidden min-w-0 flex-1 flex-col group-hover:flex text-white/90">
            <span className="text-sm font-semibold truncate">{user?.name ?? "Usuário"}</span>
            <span className="text-xs text-white/70 truncate">{user?.email ?? "sso@teletex.com"}</span>
            <button
              type="button"
              onClick={logout}
              disabled={!user}
              className="mt-2 w-fit text-xs font-medium text-white/80 hover:text-white underline-offset-2 hover:underline disabled:text-white/40"
            >
              Sair
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
