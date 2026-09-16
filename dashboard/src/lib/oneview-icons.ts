import {
  Bell,
  ChevronLeft,
  ChevronRight,
  History,
  Home,
  LogOut,
  Monitor,
  Moon,
  Radio,
  Settings,
  Sun,
  Ticket,
  UserRound,
  type LucideIcon,
} from "lucide-react";

/** Lucide React é o único pack de ícones da navegação global do OneView. */
export const ONEVIEW_ICON_MAP = {
  home: Home,
  alerts: Bell,
  links: Radio,
  incidents: Ticket,
  monitoring: Monitor,
  history: History,
  settings: Settings,
  logout: LogOut,
  notifications: Bell,
  user: UserRound,
  themeDark: Moon,
  themeLight: Sun,
  sidebarExpand: ChevronRight,
  sidebarCollapse: ChevronLeft,
} as const satisfies Record<string, LucideIcon>;

export type OneViewIconName = keyof typeof ONEVIEW_ICON_MAP;
