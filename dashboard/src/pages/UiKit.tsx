import { useState } from "react";
import { CircleAlert, Component, LayoutTemplate, Palette, Shapes } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import {
  UiKitComponentsSection,
  UiKitFoundationsSection,
  UiKitPatternsSection,
  UiKitSemanticStatesSection,
  UiKitTemplatesSection,
} from "@/components/oneview/UiKitSections";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ONEVIEW_OPERATIONAL_UI_V1_1 } from "@/lib/oneview-design-system";

const UI_KIT_CATEGORIES = [
  { value: "foundations", label: "FOUNDATIONS", icon: Palette, description: "Tokens, densidade, tipografia e iconografia." },
  { value: "patterns", label: "PATTERNS", icon: Shapes, description: "Composições operacionais reutilizáveis." },
  { value: "components", label: "COMPONENTS", icon: Component, description: "Primitives oficiais para usar dentro dos patterns." },
  { value: "templates", label: "TEMPLATES", icon: LayoutTemplate, description: "Estruturas iniciais para novas telas." },
  { value: "semantic-states", label: "SEMANTIC STATES", icon: CircleAlert, description: "Estados e severidades oficiais." },
] as const;

type UiKitCategory = (typeof UI_KIT_CATEGORIES)[number]["value"];

function UiKit() {
  const [category, setCategory] = useState<UiKitCategory>("foundations");

  return (
    <AppLayout
      clientSelect={<SectionAccentTitle level={1}>OneView UI Kit v1.1</SectionAccentTitle>}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      showHealthStrip={false}
      contentClassName="mx-auto w-full max-w-[1440px] gap-4 pb-8"
    >
      <Alert className="border-[hsl(var(--ov-color-info)/0.35)] bg-[hsl(var(--ov-color-info)/0.08)] text-foreground">
        <CircleAlert className="h-4 w-4 text-[hsl(var(--ov-color-info))]" />
        <AlertTitle>{ONEVIEW_OPERATIONAL_UI_V1_1.statement}</AlertTitle>
        <AlertDescription>
          <span className="block">Código novo deve reutilizar token, componente e Pattern oficiais.</span>
          <span className="mt-1 block">{ONEVIEW_OPERATIONAL_UI_V1_1.extensionPolicy}</span>
          <span className="mt-1 block">{ONEVIEW_OPERATIONAL_UI_V1_1.legacyPolicy}</span>
        </AlertDescription>
      </Alert>

      <Tabs value={category} onValueChange={(value) => setCategory(value as UiKitCategory)} className="space-y-4">
        <div className="sticky top-0 z-10 -mx-1 overflow-x-auto bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <TabsList aria-label="Categorias do UI Kit" className="h-auto min-w-max justify-start gap-1 rounded-[var(--ov-radius-surface)] border border-border/70 bg-muted/60 p-1">
            {UI_KIT_CATEGORIES.map((item) => {
              const Icon = item.icon;
              return <TabsTrigger key={item.value} value={item.value} className="gap-2 rounded-[var(--ov-radius-control)] px-3 py-2 text-xs"><Icon className="h-4 w-4" aria-hidden="true" />{item.label}</TabsTrigger>;
            })}
          </TabsList>
        </div>

        {UI_KIT_CATEGORIES.map((item) => (
          <TabsContent key={item.value} value={item.value} className="mt-0 space-y-4">
            <div>
              <p className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</p>
              <p className="mt-1 ov-type-secondary text-muted-foreground">{item.description}</p>
            </div>
            {item.value === "foundations" ? <UiKitFoundationsSection /> : null}
            {item.value === "components" ? <UiKitComponentsSection /> : null}
            {item.value === "patterns" ? <UiKitPatternsSection /> : null}
            {item.value === "templates" ? <UiKitTemplatesSection /> : null}
            {item.value === "semantic-states" ? <UiKitSemanticStatesSection /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </AppLayout>
  );
}

export default UiKit;
