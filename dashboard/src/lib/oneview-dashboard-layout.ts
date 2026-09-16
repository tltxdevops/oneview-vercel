export const ONEVIEW_DASHBOARD_LAYOUT_VERSION = 1 as const;

export const ONEVIEW_DASHBOARD_PAGES = ["home", "monitoring"] as const;
export type OneViewDashboardPage = typeof ONEVIEW_DASHBOARD_PAGES[number];

export const ONEVIEW_DASHBOARD_TEMPLATES = ["compact", "operational", "ultrawide", "wallboard"] as const;
export type OneViewDashboardTemplate = typeof ONEVIEW_DASHBOARD_TEMPLATES[number];

export type DashboardWidgetSize = {
  width: number;
  height: number;
};

export type OneViewDashboardWidget = {
  id: string;
  title: string;
  minWidth: number;
  minHeight: number;
  defaultSize: DashboardWidgetSize;
  allowedPages: OneViewDashboardPage[];
};

export type OneViewDashboardWidgetLayout = DashboardWidgetSize & {
  id: string;
  order: number;
  hidden: boolean;
  pinned: boolean;
};

export type OneViewDashboardLayout = {
  version: typeof ONEVIEW_DASHBOARD_LAYOUT_VERSION;
  page: OneViewDashboardPage;
  template: OneViewDashboardTemplate;
  widgets: OneViewDashboardWidgetLayout[];
};

export type OneViewDashboardPreferences = {
  version: typeof ONEVIEW_DASHBOARD_LAYOUT_VERSION;
  templates: Record<OneViewDashboardPage, OneViewDashboardTemplate>;
};

export const ONEVIEW_DASHBOARD_TEMPLATE_LABEL: Record<OneViewDashboardTemplate, string> = {
  compact: "Compacto",
  operational: "Operacional",
  ultrawide: "Ultrawide",
  wallboard: "Wallboard",
};

/**
 * Registry central. Slots de cada página reutilizam estes metadados; a próxima
 * persistência por actor_id só precisa trocar o adapter de storage abaixo.
 */
export const ONEVIEW_DASHBOARD_WIDGETS: OneViewDashboardWidget[] = [
  {
    id: "operational-summary",
    title: "Resumo operacional",
    minWidth: 3,
    minHeight: 2,
    defaultSize: { width: 12, height: 2 },
    allowedPages: ["home", "monitoring"],
  },
  {
    id: "health",
    title: "Saúde da plataforma",
    minWidth: 3,
    minHeight: 2,
    defaultSize: { width: 4, height: 2 },
    allowedPages: ["home", "monitoring"],
  },
  {
    id: "recent-alerts",
    title: "Alertas recentes",
    minWidth: 5,
    minHeight: 4,
    defaultSize: { width: 7, height: 4 },
    allowedPages: ["home"],
  },
  {
    id: "incidents",
    title: "Chamados",
    minWidth: 4,
    minHeight: 4,
    defaultSize: { width: 5, height: 4 },
    allowedPages: ["home", "monitoring"],
  },
  {
    id: "failed-links",
    title: "Links em falha",
    minWidth: 3,
    minHeight: 3,
    defaultSize: { width: 4, height: 3 },
    allowedPages: ["home"],
  },
  {
    id: "recent-events",
    title: "Eventos recentes",
    minWidth: 5,
    minHeight: 3,
    defaultSize: { width: 8, height: 4 },
    allowedPages: ["home"],
  },
  {
    id: "monitoring-queue",
    title: "Fila de monitoramento",
    minWidth: 6,
    minHeight: 5,
    defaultSize: { width: 8, height: 6 },
    allowedPages: ["monitoring"],
  },
];

const TEMPLATE_WIDTHS: Record<OneViewDashboardTemplate, Record<string, DashboardWidgetSize>> = {
  compact: {
    "operational-summary": { width: 12, height: 2 },
    health: { width: 12, height: 2 },
    "recent-alerts": { width: 12, height: 5 },
    incidents: { width: 12, height: 5 },
    "failed-links": { width: 12, height: 3 },
    "recent-events": { width: 12, height: 4 },
    "monitoring-queue": { width: 12, height: 6 },
  },
  operational: {
    "operational-summary": { width: 12, height: 2 },
    health: { width: 4, height: 2 },
    "recent-alerts": { width: 7, height: 4 },
    incidents: { width: 5, height: 4 },
    "failed-links": { width: 4, height: 4 },
    "recent-events": { width: 8, height: 4 },
    "monitoring-queue": { width: 8, height: 6 },
  },
  ultrawide: {
    "operational-summary": { width: 12, height: 2 },
    health: { width: 3, height: 2 },
    "recent-alerts": { width: 8, height: 5 },
    incidents: { width: 4, height: 5 },
    "failed-links": { width: 4, height: 4 },
    "recent-events": { width: 8, height: 4 },
    "monitoring-queue": { width: 9, height: 6 },
  },
  wallboard: {
    "operational-summary": { width: 12, height: 3 },
    health: { width: 4, height: 3 },
    "recent-alerts": { width: 8, height: 6 },
    incidents: { width: 4, height: 6 },
    "failed-links": { width: 4, height: 5 },
    "recent-events": { width: 8, height: 5 },
    "monitoring-queue": { width: 8, height: 7 },
  },
};

function clampWidth(width: number, widget: OneViewDashboardWidget) {
  return Math.max(widget.minWidth, Math.min(12, Math.trunc(width) || widget.minWidth));
}

function clampHeight(height: number, widget: OneViewDashboardWidget) {
  return Math.max(widget.minHeight, Math.min(8, Math.trunc(height) || widget.minHeight));
}

function definitionFor(id: string, widgets: OneViewDashboardWidget[]) {
  return widgets.find((widget) => widget.id === id) ?? null;
}

export function compactOneViewDashboardWidgets(
  widgets: Array<OneViewDashboardWidgetLayout | null | undefined>,
): OneViewDashboardWidgetLayout[] {
  return widgets.filter((item): item is OneViewDashboardWidgetLayout => Boolean(item && typeof item.id === "string"));
}

export function dashboardWidgetsForPage(page: OneViewDashboardPage) {
  return ONEVIEW_DASHBOARD_WIDGETS.filter((widget) => widget.allowedPages.includes(page));
}

export function createOneViewDashboardLayout(
  page: OneViewDashboardPage,
  template: OneViewDashboardTemplate = "operational",
  widgets = dashboardWidgetsForPage(page),
): OneViewDashboardLayout {
  const templateSizes = TEMPLATE_WIDTHS[template];
  return {
    version: ONEVIEW_DASHBOARD_LAYOUT_VERSION,
    page,
    template,
    widgets: widgets.map((widget, order) => {
      const size = templateSizes[widget.id] ?? widget.defaultSize;
      return {
        id: widget.id,
        order,
        width: clampWidth(size.width, widget),
        height: clampHeight(size.height, widget),
        hidden: false,
        pinned: false,
      };
    }),
  };
}

export function normalizeOneViewDashboardLayout(
  candidate: unknown,
  page: OneViewDashboardPage,
  template: OneViewDashboardTemplate,
  widgets = dashboardWidgetsForPage(page),
): OneViewDashboardLayout {
  const fallback = createOneViewDashboardLayout(page, template, widgets);
  if (!candidate || typeof candidate !== "object") return fallback;

  const value = candidate as Partial<OneViewDashboardLayout>;
  if (value.version !== ONEVIEW_DASHBOARD_LAYOUT_VERSION || value.page !== page || value.template !== template || !Array.isArray(value.widgets)) {
    return fallback;
  }

  const savedById = new Map(
    compactOneViewDashboardWidgets(value.widgets).map((item) => [item.id, item]),
  );

  const widgetsLayout = widgets.map((widget, fallbackOrder) => {
    const saved = savedById.get(widget.id);
    if (!saved) return fallback.widgets[fallbackOrder];
    return {
      id: widget.id,
      order: Number.isFinite(saved.order) ? Math.max(0, Math.trunc(saved.order)) : fallbackOrder,
      width: clampWidth(saved.width, widget),
      height: clampHeight(saved.height, widget),
      hidden: Boolean(saved.hidden),
      pinned: Boolean(saved.pinned),
    };
  }).sort((a, b) => a.order - b.order).map((item, order) => ({ ...item, order }));

  return repairOneViewDashboardLayout({
    ...fallback,
    widgets: widgetsLayout,
  }, widgets);
}

export function repairOneViewDashboardLayout(
  layout: OneViewDashboardLayout,
  widgets = dashboardWidgetsForPage(layout.page),
): OneViewDashboardLayout {
  const fallback = createOneViewDashboardLayout(layout.page, layout.template, widgets);
  const byId = new Map(compactOneViewDashboardWidgets(layout.widgets).map((item) => [item.id, item]));
  const next = {
    ...fallback,
    widgets: fallback.widgets.map((item, order) => {
      const saved = byId.get(item.id);
      if (!saved) return { ...item, order };
      return { ...saved, id: item.id, order };
    }),
  };
  if (next.widgets.some((item) => item && !item.hidden)) return next;
  return {
    ...next,
    widgets: next.widgets.map((item, order) => ({ ...item, hidden: false, order })),
  };
}

export function dashboardActorStorageKey(actorId?: string | null) {
  const normalized = String(actorId || "anonymous")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "anonymous";
}

export function oneViewDashboardStorageKey(
  page: OneViewDashboardPage,
  actorId: string | null | undefined,
  template: OneViewDashboardTemplate,
) {
  return `oneview.dashboard-layout.v${ONEVIEW_DASHBOARD_LAYOUT_VERSION}:${page}:${dashboardActorStorageKey(actorId)}:${template}`;
}

export function oneViewDashboardPreferencesStorageKey(actorId?: string | null) {
  return `oneview.dashboard-preferences.v${ONEVIEW_DASHBOARD_LAYOUT_VERSION}:${dashboardActorStorageKey(actorId)}`;
}

export function defaultOneViewDashboardPreferences(): OneViewDashboardPreferences {
  return {
    version: ONEVIEW_DASHBOARD_LAYOUT_VERSION,
    templates: {
      home: "operational",
      monitoring: "operational",
    },
  };
}

export function readOneViewDashboardPreferences(actorId?: string | null): OneViewDashboardPreferences {
  const fallback = defaultOneViewDashboardPreferences();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(oneViewDashboardPreferencesStorageKey(actorId));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<OneViewDashboardPreferences>;
    if (value.version !== ONEVIEW_DASHBOARD_LAYOUT_VERSION || !value.templates) return fallback;
    const templates = value.templates as Partial<Record<OneViewDashboardPage, unknown>>;
    return {
      ...fallback,
      templates: {
        home: ONEVIEW_DASHBOARD_TEMPLATES.includes(templates.home as OneViewDashboardTemplate)
          ? templates.home as OneViewDashboardTemplate
          : fallback.templates.home,
        monitoring: ONEVIEW_DASHBOARD_TEMPLATES.includes(templates.monitoring as OneViewDashboardTemplate)
          ? templates.monitoring as OneViewDashboardTemplate
          : fallback.templates.monitoring,
      },
    };
  } catch {
    return fallback;
  }
}

export function writeOneViewDashboardPreferences(
  preferences: OneViewDashboardPreferences,
  actorId?: string | null,
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(oneViewDashboardPreferencesStorageKey(actorId), JSON.stringify(preferences));
  } catch {
    // Browser storage is optional; the active layout remains usable in memory.
  }
}

export function setOneViewDashboardPreferredTemplate(
  page: OneViewDashboardPage,
  template: OneViewDashboardTemplate,
  actorId?: string | null,
) {
  const next = readOneViewDashboardPreferences(actorId);
  const preferences = { ...next, templates: { ...next.templates, [page]: template } };
  writeOneViewDashboardPreferences(preferences, actorId);
  return preferences;
}

export function resetOneViewDashboardPreferences(actorId?: string | null) {
  const preferences = defaultOneViewDashboardPreferences();
  if (typeof window !== "undefined") {
    try {
      for (const page of ONEVIEW_DASHBOARD_PAGES) {
        for (const template of ONEVIEW_DASHBOARD_TEMPLATES) {
          window.localStorage.removeItem(oneViewDashboardStorageKey(page, actorId, template));
        }
      }
    } catch {
      // Continue and restore the default preference when selective deletion is unavailable.
    }
  }
  writeOneViewDashboardPreferences(preferences, actorId);
  return preferences;
}

export function readOneViewDashboardLayout(
  page: OneViewDashboardPage,
  actorId: string | null | undefined,
  template: OneViewDashboardTemplate,
  widgets = dashboardWidgetsForPage(page),
) {
  if (typeof window === "undefined") return createOneViewDashboardLayout(page, template, widgets);
  try {
    const raw = window.localStorage.getItem(oneViewDashboardStorageKey(page, actorId, template));
    return normalizeOneViewDashboardLayout(raw ? JSON.parse(raw) : null, page, template, widgets);
  } catch {
    return createOneViewDashboardLayout(page, template, widgets);
  }
}

export function writeOneViewDashboardLayout(layout: OneViewDashboardLayout, actorId?: string | null) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      oneViewDashboardStorageKey(layout.page, actorId, layout.template),
      JSON.stringify(layout),
    );
  } catch {
    // Prefer a stable in-memory layout when browser storage is unavailable.
  }
}

export function applyOneViewDashboardTemplate(
  layout: OneViewDashboardLayout,
  template: OneViewDashboardTemplate,
  widgets = dashboardWidgetsForPage(layout.page),
) {
  const preset = createOneViewDashboardLayout(layout.page, template, widgets);
  const currentById = new Map(compactOneViewDashboardWidgets(layout.widgets).map((item) => [item.id, item]));
  const prepared = preset.widgets.map((item) => {
    const current = currentById.get(item.id);
    if (current?.pinned) return { ...current };
    return { ...item, hidden: Boolean(current?.hidden), pinned: false };
  });
  const pinned = prepared.filter((item) => item.pinned).sort((a, b) => a.order - b.order);
  const movable = prepared.filter((item) => !item.pinned);
  const slots = Array.from({ length: prepared.length }, () => null as OneViewDashboardWidgetLayout | null);
  for (const item of pinned) {
    let slot = Math.max(0, Math.min(slots.length - 1, item.order));
    if (slots[slot]) slot = slots.findIndex((candidate) => candidate == null);
    if (slot < 0) continue;
    slots[slot] = item;
  }
  let movableIndex = 0;
  return {
    ...preset,
    widgets: slots.map((item, order) => ({ ...(item ?? movable[movableIndex++] ?? prepared[order]), order })),
  } satisfies OneViewDashboardLayout;
}

export function updateOneViewDashboardWidget(
  layout: OneViewDashboardLayout,
  id: string,
  patch: Partial<Pick<OneViewDashboardWidgetLayout, "width" | "height" | "hidden" | "pinned">>,
  widgets = dashboardWidgetsForPage(layout.page),
) {
  const definition = definitionFor(id, widgets);
  if (!definition) return layout;
  const next = {
    ...layout,
    widgets: compactOneViewDashboardWidgets(layout.widgets).map((item) => item.id !== id ? item : {
      ...item,
      ...patch,
      width: patch.width === undefined ? item.width : clampWidth(patch.width, definition),
      height: patch.height === undefined ? item.height : clampHeight(patch.height, definition),
    }),
  };
  return repairOneViewDashboardLayout(next, widgets);
}

export function reorderOneViewDashboardWidgets(layout: OneViewDashboardLayout, sourceId: string, targetId: string) {
  if (sourceId === targetId) return layout;
  const widgets = compactOneViewDashboardWidgets(layout.widgets);
  const source = widgets.find((item) => item.id === sourceId);
  const target = widgets.find((item) => item.id === targetId);
  if (!source || !target || source.pinned || target.pinned) return layout;

  const ordered = [...widgets].sort((a, b) => a.order - b.order);
  const movable = ordered.filter((item) => !item.pinned);
  const sourceIndex = movable.findIndex((item) => item.id === sourceId);
  const targetIndex = movable.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return layout;
  const nextMovable = [...movable];
  const [moved] = nextMovable.splice(sourceIndex, 1);
  if (!moved) return layout;
  nextMovable.splice(targetIndex, 0, moved);
  let movableIndex = 0;
  return {
    ...layout,
    widgets: ordered.map((item, order) => item.pinned
      ? { ...item, order }
      : { ...(nextMovable[movableIndex++] ?? item), order }),
  };
}
