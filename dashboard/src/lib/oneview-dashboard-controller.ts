import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyOneViewDashboardTemplate,
  compactOneViewDashboardWidgets,
  createOneViewDashboardLayout,
  dashboardWidgetsForPage,
  oneViewDashboardStorageKey,
  readOneViewDashboardPreferences,
  readOneViewDashboardLayout,
  reorderOneViewDashboardWidgets,
  repairOneViewDashboardLayout,
  updateOneViewDashboardWidget,
  setOneViewDashboardPreferredTemplate,
  writeOneViewDashboardLayout,
  type OneViewDashboardLayout,
  type OneViewDashboardPage,
  type OneViewDashboardTemplate,
  type OneViewDashboardWidget,
} from "@/lib/oneview-dashboard-layout";

type UseOneViewDashboardLayoutOptions = {
  page: OneViewDashboardPage;
  actorId?: string | null;
  widgets?: OneViewDashboardWidget[];
  initialTemplate?: OneViewDashboardTemplate;
};

export type OneViewDashboardController = {
  layout: OneViewDashboardLayout;
  widgets: OneViewDashboardWidget[];
  isEditing: boolean;
  isWallboard: boolean;
  draggedId: string | null;
  setEditing: (editing: boolean) => void;
  setDraggedId: (id: string | null) => void;
  selectTemplate: (template: OneViewDashboardTemplate) => void;
  resetLayout: () => void;
  updateWidget: (id: string, patch: { width?: number; height?: number; hidden?: boolean; pinned?: boolean; itemLimit?: number }) => void;
  reorderWidgets: (sourceId: string, targetId: string) => void;
};

function templateFromStorage(
  page: OneViewDashboardPage,
  actorId: string | null | undefined,
  template: OneViewDashboardTemplate,
  widgets: OneViewDashboardWidget[],
) {
  const next = readOneViewDashboardLayout(page, actorId, template, widgets);
  if (typeof window === "undefined") return { layout: next, hasStoredLayout: false };
  try {
    return {
      layout: next,
      hasStoredLayout: Boolean(window.localStorage.getItem(oneViewDashboardStorageKey(page, actorId, template))),
    };
  } catch {
    return { layout: next, hasStoredLayout: false };
  }
}

/** V1 device-local adapter; future persistence can replace only this adapter. */
export function useOneViewDashboardLayout({
  page,
  actorId,
  widgets: suppliedWidgets,
  initialTemplate,
}: UseOneViewDashboardLayoutOptions): OneViewDashboardController {
  const widgets = useMemo(
    () => suppliedWidgets ?? dashboardWidgetsForPage(page),
    [page, suppliedWidgets],
  );
  const preferredTemplate = initialTemplate ?? readOneViewDashboardPreferences(actorId).templates[page] ?? "operational";
  const widgetSignature = useMemo(() => widgets.map((widget) => widget.id).join("|"), [widgets]);
  const storageScope = `${page}:${actorId || "anonymous"}:${widgetSignature}`;
  const [layout, setLayout] = useState(() => readOneViewDashboardLayout(page, actorId, preferredTemplate, widgets));
  const [isEditing, setEditing] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const storageScopeRef = useRef(storageScope);

  useEffect(() => {
    if (storageScopeRef.current === storageScope) return;
    storageScopeRef.current = storageScope;
    setEditing(false);
    const nextTemplate = initialTemplate ?? readOneViewDashboardPreferences(actorId).templates[page] ?? "operational";
    setLayout(readOneViewDashboardLayout(page, actorId, nextTemplate, widgets));
  }, [actorId, initialTemplate, page, storageScope, widgets]);

  useEffect(() => {
    const widgetsPresent = compactOneViewDashboardWidgets(layout.widgets);
    if (widgetsPresent.length !== widgets.length || widgetsPresent.length !== layout.widgets.length) {
      setLayout(repairOneViewDashboardLayout(layout, widgets));
      return;
    }
    writeOneViewDashboardLayout(layout, actorId);
  }, [actorId, layout, widgets]);

  const selectTemplate = useCallback((template: OneViewDashboardTemplate) => {
    setLayout((current) => {
      const candidate = templateFromStorage(page, actorId, template, widgets);
      const next = candidate.hasStoredLayout
        ? candidate.layout
        : applyOneViewDashboardTemplate(current, template, widgets);
      return repairOneViewDashboardLayout(next, widgets);
    });
    setOneViewDashboardPreferredTemplate(page, template, actorId);
    setDraggedId(null);
  }, [actorId, page, widgets]);

  const resetLayout = useCallback(() => {
    setLayout((current) => createOneViewDashboardLayout(page, current.template, widgets));
  }, [page, widgets]);

  const updateWidget = useCallback((id: string, patch: { width?: number; height?: number; hidden?: boolean; pinned?: boolean; itemLimit?: number }) => {
    setLayout((current) => updateOneViewDashboardWidget(current, id, patch, widgets));
  }, [widgets]);

  const reorderWidgets = useCallback((sourceId: string, targetId: string) => {
    setLayout((current) => reorderOneViewDashboardWidgets(current, sourceId, targetId));
  }, []);

  return {
    layout,
    widgets,
    isEditing,
    isWallboard: layout.template === "wallboard",
    draggedId,
    setEditing,
    setDraggedId,
    selectTemplate,
    resetLayout,
    updateWidget,
    reorderWidgets,
  };
}
