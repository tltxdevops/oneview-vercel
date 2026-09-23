import type { ComponentProps } from "react";
import type { OneViewMetricGridProfile, OneViewMetricStripController } from "@/lib/oneview-metric-strip-preferences";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";

type ConfigurableMetricStripProps = Omit<ComponentProps<typeof CompactMetricStrip>, "editable" | "onMetricSpanChange" | "onMetricRowSpanChange"> & {
  controller: OneViewMetricStripController<string>;
  editable?: boolean;
  gridProfile?: OneViewMetricGridProfile;
  gridClassName?: string;
};

export function ConfigurableMetricStrip({
  controller,
  editable = false,
  items,
  gridProfile = "chamados",
  gridClassName = "ov-chamados-metric-grid",
  ...rest
}: ConfigurableMetricStripProps) {
  return (
    <CompactMetricStrip
      {...rest}
      layoutMode="configurable"
      gridProfile={gridProfile}
      gridClassName={gridClassName}
      density={controller.density}
      editable={editable}
      onMetricSpanChange={(id, span) => controller.setSpan(id, span)}
      onMetricRowSpanChange={(id, rowSpan) => controller.setRowSpan(id, rowSpan)}
      items={items}
    />
  );
}
