import { useState, type ReactNode } from "react";
import { ChevronDown, Inbox, ListFilter, Search, SlidersHorizontal } from "lucide-react";
import {
  OneViewButton,
  OneViewFeedback,
  OneViewHealthIndicator,
  OneViewKpiCard,
  OneViewPanel,
  OneViewPill,
  OneViewSemanticStatusBadge,
  OneViewSeverityBadge,
  OneViewTextAction,
  SemanticBadge,
  SectionAccentTitle,
} from "@/components/oneview/OneViewDesignSystem";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ONEVIEW_COLOR_TOKENS,
  ONEVIEW_ACTION_COLORS,
  ONEVIEW_COMPONENT_RULES,
  ONEVIEW_CONTROL_HEIGHTS,
  ONEVIEW_DESIGN_RULES,
  ONEVIEW_ICON_RULES,
  ONEVIEW_LAYOUT_RULES,
  ONEVIEW_LEGACY_COMPATIBILITY,
  ONEVIEW_RADIUS_DECISIONS,
  ONEVIEW_SEVERITY_CATALOG,
  ONEVIEW_SPACING_TOKENS,
  ONEVIEW_STATUS_CATALOG,
  ONEVIEW_TABLE_RULE,
  ONEVIEW_TYPOGRAPHY_TOKENS,
  type OneViewSemanticStatus,
} from "@/lib/oneview-design-system";
import { cn } from "@/lib/utils";

const STATUS_GROUPS: Array<{ title: string; statuses: OneViewSemanticStatus[] }> = [
  { title: "Monitoramento", statuses: ["monitoring-down", "monitoring-normalized"] },
  {
    title: "ServiceNow",
    statuses: [
      "incident-new",
      "incident-progress",
      "incident-waiting",
      "incident-resolved",
      "incident-closed",
      "incident-cancelled",
    ],
  },
  { title: "Operacional", statuses: ["divergence", "recurrence", "classification-pending"] },
];

const TEMPLATE_DEFINITIONS = [
  { title: "Operational List", description: "Header, filtros, KPIs e tabela.", blocks: ["header", "filters", "kpis", "table"] },
  { title: "Dashboard", description: "Health, KPIs e widgets.", blocks: ["health", "kpis", "widget", "widget"] },
  { title: "History/Search", description: "Busca, período, resultados e detalhe.", blocks: ["search", "period", "table", "detail"] },
  { title: "Incident Queue", description: "Visão, filtros, fila e contexto.", blocks: ["tabs", "filters", "queue", "detail"] },
  { title: "Operational Overview", description: "PageHeader, ContextBar, OperationalSummary, ActionGrid 60/40 e faixa de suporte para Links de operadoras e Eventos.", blocks: ["header", "context", "summary", "60/40"] },
  { title: "NOC Monitoring", description: "PageHeader, OperationalFilterBar, QuickFilters, SeverityStrip, NocGrid 60/40, OperationalQueue e IncidentQueue.", blocks: ["header", "filters", "quick", "severity", "60/40", "queue", "incidents"] },
  { title: "Settings/Form", description: "Formulário com largura e densidade controladas.", blocks: ["header", "field", "field", "actions"] },
] as const;

function CodeLabel({ children }: { children: string }) {
  return <code className="rounded-[var(--ov-radius-control)] bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{children}</code>;
}

function Decision({ title, value, children }: { title: string; value: string; children: ReactNode }) {
  return (
    <div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-4 shadow-none">
      <p className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 ov-type-section-title">{value}</p>
      <div className="mt-2 ov-type-secondary text-muted-foreground">{children}</div>
    </div>
  );
}

function PatternFrame({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="ov-surface-official p-4">
      <p className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">Pattern {number}</p>
      <h3 className="mt-1 ov-type-section-title">{title}</h3>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function OperationalTable({ empty = false }: { empty?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-[var(--ov-radius-surface)] border border-border bg-background shadow-none">
      <Table className="ov-operational-table">
        <TableHeader>
          <TableRow>
            <TableHead className="ov-type-caption font-semibold">Subject</TableHead>
            <TableHead className="ov-type-caption font-semibold">Status</TableHead>
            <TableHead className="ov-type-caption text-right font-semibold">Ação</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {empty ? (
            <TableRow><TableCell colSpan={3} className="h-24 text-center ov-type-secondary text-muted-foreground">Nenhum item encontrado.</TableCell></TableRow>
          ) : (
            <>
              <TableRow>
                <TableCell className="ov-type-body font-semibold">Cliente · Unidade principal</TableCell>
                <TableCell><OneViewSemanticStatusBadge status="monitoring-down" /></TableCell>
                <TableCell className="text-right"><OneViewButton variant="ghost" className="h-8 min-h-8">Abrir</OneViewButton></TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="ov-type-body font-semibold">Cliente · Filial</TableCell>
                <TableCell><OneViewSemanticStatusBadge status="monitoring-normalized" /></TableCell>
                <TableCell className="text-right"><OneViewButton variant="ghost" className="h-8 min-h-8">Abrir</OneViewButton></TableCell>
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function OfficialFilterBar() {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-[11rem_minmax(16rem,1fr)_auto]">
        <Select defaultValue="down">
          <SelectTrigger className="h-9 rounded-[var(--ov-radius-control)]"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="down">Em falha</SelectItem><SelectItem value="all">Todos</SelectItem></SelectContent>
        </Select>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-9 rounded-[var(--ov-radius-control)] pl-9" placeholder="Buscar cliente, host ou INC" aria-label="Buscar" />
        </label>
        <OneViewButton variant="secondary"><ListFilter className="mr-2 h-[18px] w-[18px]" />Mais filtros</OneViewButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OneViewPill selected>Com chamado</OneViewPill>
        <OneViewTextAction>Limpar filtros</OneViewTextAction>
      </div>
    </div>
  );
}

export function UiKitFoundationsSection() {
  return (
    <div className="space-y-4">
      <OneViewPanel title="ONEVIEW DESIGN RULES" description="Estas regras têm precedência sobre preferências locais.">
        <ol className="grid gap-x-8 gap-y-2 md:grid-cols-2">
          {ONEVIEW_DESIGN_RULES.map((rule, index) => (
            <li key={rule} className="flex gap-3 ov-type-body"><span className="w-5 shrink-0 font-semibold tabular-nums text-muted-foreground">{index + 1}.</span><span>{rule}</span></li>
          ))}
        </ol>
      </OneViewPanel>

      <OneViewPanel title="DESIGN DECISIONS" description="O padrão já decidiu. Código novo escolhe o componente e o contexto, não uma variação visual.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Decision title="Radius" value="8 / 12 / pill">
            Controls 8px. Surfaces 12px. Pills somente para metadata, status, severity e filtros.
          </Decision>
          <Decision title="Spacing" value="4 / 8 / 12 / 16 / 24 / 32">
            Cada valor possui um uso oficial; 20px não é uma decisão nova.
          </Decision>
          <Decision title="Typography" value="6 papéis">
            Page Title, Section Title, Body, Secondary, Caption e Metric.
          </Decision>
          <Decision title="Controls" value="32px / 36px">
            Uma altura por contexto. Forms usam 36px; compacto é exceção operacional.
          </Decision>
          <Decision title="Surface" value="Border + no shadow">
            Fundo neutro, borda de 1px, raio de 12px e padding padrão de 16px.
          </Decision>
          <Decision title="Color" value="Neutral first">
            Preto é primary. Cores fortes comunicam estado; nunca decoram uma superfície inteira.
          </Decision>
        </div>
      </OneViewPanel>

      <div className="grid gap-4 xl:grid-cols-2">
        <OneViewPanel title="Accent & Title Signature" description="Accent blue identifica marca, navegação e seleção. O underscore aparece somente em títulos estratégicos.">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-4">
              <p className="ov-type-caption font-semibold uppercase text-muted-foreground">OLD</p>
              <p className="mt-3 ov-type-page-title">Links</p>
              <p className="mt-2 ov-type-caption text-muted-foreground">Título sem assinatura.</p>
            </div>
            <div className="rounded-[var(--ov-radius-surface)] border border-[hsl(var(--ov-color-accent-blue)/0.35)] bg-[hsl(var(--ov-color-accent-blue)/0.05)] p-4">
              <p className="ov-type-caption font-semibold uppercase text-[hsl(var(--ov-color-accent-blue))]">V1.1</p>
              <div className="mt-3"><SectionAccentTitle level={1}>Links</SectionAccentTitle></div>
              <p className="mt-2 ov-type-caption text-muted-foreground">SectionAccentTitle · underscore accent blue.</p>
            </div>
          </div>
          <p className="mt-3 ov-type-secondary text-muted-foreground">Permitido: Page Title e grandes Section Titles estratégicos. Proibido: labels, botões, tabelas, cards e widgets.</p>
        </OneViewPanel>

        <OneViewPanel title="Navigation" description="Rota ativa deve ser reconhecida em menos de um segundo.">
          <div className="rounded-[var(--ov-radius-surface)] bg-sidebar p-3 text-sidebar-foreground">
            <div className="relative flex h-10 items-center rounded-[var(--ov-radius-control)] border border-[hsl(var(--ov-color-accent-blue)/0.28)] bg-[hsl(var(--ov-color-accent-blue)/0.14)] px-4 before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-full before:bg-[hsl(var(--ov-color-accent-blue))]">
              <span className="h-4 w-4 rounded-[var(--ov-radius-control)] border-2 border-[hsl(var(--ov-color-accent-blue))]" aria-hidden="true" />
              <span className="ml-3 ov-type-body font-bold">Links</span>
              <span className="ml-auto ov-type-caption text-sidebar-foreground/60">Active</span>
            </div>
          </div>
          <p className="mt-3 ov-type-secondary text-muted-foreground">Barra vertical azul, ícone contrastante, surface azul sutil, label expandida e foco inequívoco.</p>
        </OneViewPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <OneViewPanel title="Radius oficial" description="Três decisões, sem combinações locais.">
          <div className="space-y-3">
            {ONEVIEW_RADIUS_DECISIONS.map((token) => (
              <div key={token.name} className="grid grid-cols-[72px_1fr] items-center gap-3">
                <div className="h-12 border border-primary bg-primary/5" style={{ borderRadius: `var(${token.variable})` }} />
                <div><p className="ov-type-body font-semibold">{token.name} · {token.value}</p><p className="ov-type-secondary text-muted-foreground">{token.use}</p></div>
              </div>
            ))}
          </div>
        </OneViewPanel>

        <OneViewPanel title="Spacing oficial" description="Valor e responsabilidade fixa.">
          <div className="space-y-3">
            {ONEVIEW_SPACING_TOKENS.map((token) => (
              <div key={token.pixels} className="grid grid-cols-[48px_1fr] gap-3">
                <CodeLabel>{`${token.pixels}px`}</CodeLabel>
                <p className="ov-type-secondary text-muted-foreground">{token.use}</p>
              </div>
            ))}
          </div>
        </OneViewPanel>

        <OneViewPanel title="Typography" description="JetBrains Mono para títulos, métricas e metadado técnico; Lato para leitura e formulários.">
          <div className="space-y-3">
            {ONEVIEW_TYPOGRAPHY_TOKENS.map((token) => (
              <div key={token.name} className="grid gap-1 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:grid-cols-[8rem_7rem_1fr] sm:items-center">
                <p className="ov-type-caption font-semibold">{token.name}</p>
                <p className="ov-type-caption text-muted-foreground">{token.specification}</p>
                <p className={token.className}>OneView operacional</p>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-border/60 pt-3 ov-type-caption ov-type-caption-technical text-muted-foreground">INC0012345 · 2026-09-16 14:32:08 · caption técnico</p>
        </OneViewPanel>

        <OneViewPanel title="Controls & surface" description="A mesma decisão se repete em toda tela.">
          <div className="space-y-4">
            {ONEVIEW_CONTROL_HEIGHTS.map((control) => (
              <div key={control.name} className="flex items-center gap-3"><div className="w-28 rounded-[var(--ov-radius-control)] border border-border bg-background" style={{ height: control.value }} /><div><p className="ov-type-body font-semibold">{control.name} · {control.value}</p><p className="ov-type-secondary text-muted-foreground">{control.use}</p></div></div>
            ))}
            <div className="ov-surface-official p-4"><p className="ov-type-body font-semibold">DEFAULT SURFACE</p><p className="mt-1 ov-type-secondary text-muted-foreground">background neutro · border 1px · radius 12px · sem shadow</p></div>
          </div>
        </OneViewPanel>

        <OneViewPanel title="Color oficial" description="Base neutra e seis tons semânticos.">
          <div className="grid gap-2 sm:grid-cols-2">
            {ONEVIEW_COLOR_TOKENS.map(([name, variable]) => (
              <div key={name} className="flex items-center gap-3 rounded-[var(--ov-radius-control)] border border-border p-2">
                <span className="h-6 w-6 shrink-0 rounded-[var(--ov-radius-control)] border border-border" style={{ backgroundColor: `hsl(var(${variable}))` }} />
                <span className="ov-type-secondary">{name}</span>
              </div>
            ))}
          </div>
        </OneViewPanel>

        <OneViewPanel title="Page width & iconography" description="Layout também é uma decisão do sistema.">
          <div className="space-y-3">
            {Object.entries(ONEVIEW_LAYOUT_RULES).map(([name, rule]) => <p key={name} className="ov-type-secondary"><span className="font-semibold capitalize text-foreground">{name}:</span> <span className="text-muted-foreground">{rule}</span></p>)}
            <div className="border-t border-border/60 pt-3">{ONEVIEW_ICON_RULES.map((rule) => <p key={rule.size} className="ov-type-secondary"><span className="font-semibold">{rule.size}</span> <span className="text-muted-foreground">· {rule.use}</span></p>)}</div>
            <p className="ov-type-caption text-muted-foreground">Lucide React · stroke-width consistente · sem SVG custom quando existir equivalente.</p>
          </div>
        </OneViewPanel>

        <OneViewPanel title="Component contracts" description="Uma regra por família oficial.">
          <div className="space-y-3">
            {Object.entries(ONEVIEW_COMPONENT_RULES).map(([name, rule]) => <p key={name} className="ov-type-secondary"><span className="font-semibold capitalize text-foreground">{name}:</span> <span className="text-muted-foreground">{rule}</span></p>)}
          </div>
        </OneViewPanel>
      </div>

      <OneViewPanel title="Legacy / compatibility" description="Existe somente para telas ainda não migradas.">
        <details>
          <summary className="cursor-pointer ov-type-body font-semibold">Mostrar tokens legados — não usar em código novo</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Object.entries(ONEVIEW_LEGACY_COMPATIBILITY).filter(([key]) => key !== "note").map(([group, values]) => (
              <div key={group}><p className="ov-type-caption font-semibold uppercase text-muted-foreground">{group}</p><div className="mt-2 flex flex-wrap gap-2">{(values as readonly string[]).map((value) => <CodeLabel key={value}>{value}</CodeLabel>)}</div></div>
            ))}
          </div>
        </details>
      </OneViewPanel>
    </div>
  );
}

export function UiKitPatternsSection() {
  return (
    <div className="space-y-4">
      <OneViewPanel title="Patterns antes de primitives" description="Nova página começa por um pattern oficial. Links / Operadoras é a referência operacional.">
        <p className="ov-type-body">Copie a composição e conecte os dados. Crie layout novo somente quando nenhum pattern resolver o fluxo.</p>
      </OneViewPanel>
      <div className="grid gap-4 xl:grid-cols-2">
        <PatternFrame number="01" title="Page Header">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="ov-type-page-title">Links / Operadoras</p><p className="mt-1 ov-type-secondary text-muted-foreground">Visão operacional consolidada.</p></div><div className="flex items-center gap-3"><OneViewHealthIndicator status="healthy" label="OneView saudável" /><OneViewButton>Atualizar</OneViewButton></div></div>
        </PatternFrame>
        <PatternFrame number="02" title="Operational Page">
          <div className="space-y-3"><div className="flex items-center justify-between"><p className="ov-type-section-title">Fila operacional</p><OneViewHealthIndicator status="healthy" label="Dados atuais" /></div><div className="grid gap-2 sm:grid-cols-3"><OneViewKpiCard className="ov-kpi-official" label="Em falha" value="12" tone="danger" /><OneViewKpiCard className="ov-kpi-official" label="Recorrentes" value="6" tone="recurrence" /><OneViewKpiCard className="ov-kpi-official" label="Divergências" value="3" tone="warning" /></div><OfficialFilterBar /><OperationalTable /></div>
        </PatternFrame>
        <PatternFrame number="03" title="Filter Bar"><OfficialFilterBar /></PatternFrame>
        <PatternFrame number="04" title="Operational Table"><OperationalTable /><p className="mt-3 ov-type-caption text-muted-foreground">{Object.values(ONEVIEW_TABLE_RULE).join(" · ")}</p></PatternFrame>
        <PatternFrame number="05" title="Drawer">
          <div className="space-y-3"><div className="flex items-start justify-between gap-3"><div><p className="ov-type-section-title">Cliente · Unidade principal</p><p className="ov-type-secondary text-muted-foreground">Detalhe operacional</p></div><OneViewSemanticStatusBadge status="monitoring-down" /></div>{["Resumo operacional", "Chamado atual", "Alerta atual", "Detalhes técnicos"].map((section) => <div key={section} className="ov-surface-official p-4"><p className="ov-type-body font-semibold">{section}</p></div>)}<div className="flex justify-end gap-2 border-t border-border pt-4"><OneViewButton variant="secondary">Fechar</OneViewButton><OneViewButton>Acompanhar</OneViewButton></div></div>
        </PatternFrame>
        <PatternFrame number="06" title="Dashboard">
          <div className="space-y-3"><div className="flex justify-end"><OneViewHealthIndicator status="healthy" label="Health operacional" /></div><div className="grid gap-2 sm:grid-cols-3"><OneViewKpiCard className="ov-kpi-official" label="Alertas" value="12" tone="danger" /><OneViewKpiCard className="ov-kpi-official" label="Links" value="5" tone="warning" /><OneViewKpiCard className="ov-kpi-official" label="Theo" value="OK" tone="success" /></div><div className="grid gap-2 sm:grid-cols-2"><div className="ov-surface-official min-h-24 p-4 ov-type-body">Widget operacional</div><div className="ov-surface-official min-h-24 p-4 ov-type-body">Widget de health</div></div></div>
        </PatternFrame>
        <PatternFrame number="07" title="Form">
          <div className="mx-auto max-w-lg space-y-4"><label className="block space-y-2"><span className="ov-type-body font-semibold">Nome</span><Input className="h-9 rounded-[var(--ov-radius-control)]" placeholder="Nome da configuração" /></label><label className="block space-y-2"><span className="ov-type-body font-semibold">Contexto</span><Select defaultValue="operational"><SelectTrigger className="h-9 rounded-[var(--ov-radius-control)]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="operational">Operacional</SelectItem></SelectContent></Select></label><div className="flex justify-end gap-2"><OneViewButton variant="secondary">Cancelar</OneViewButton><OneViewButton>Salvar</OneViewButton></div></div>
        </PatternFrame>
        <PatternFrame number="08" title="Operational Overview">
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><SectionAccentTitle level={1}>Início</SectionAccentTitle><p className="ov-type-secondary text-muted-foreground">Visão geral da operação Teletex</p></div><OneViewHealthIndicator status="healthy" label="Health global" /></div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><span className="ov-type-caption font-semibold uppercase text-muted-foreground">Context Bar · 30m · Cliente · Atualizado agora</span><OneViewPill selected>30m</OneViewPill></div>
            <div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Resumo operacional</SectionAccentTitle><div className="mt-2 grid grid-cols-5 divide-x divide-border"><div className="px-2 text-center"><p className="ov-type-caption text-muted-foreground">Information</p><p className="ov-type-metric">4</p></div><div className="px-2 text-center"><p className="ov-type-caption text-muted-foreground">Warning</p><p className="ov-type-metric">6</p></div><div className="px-2 text-center"><p className="ov-type-caption text-muted-foreground">Average</p><p className="ov-type-metric">3</p></div><div className="px-2 text-center"><p className="ov-type-caption text-muted-foreground">High</p><p className="ov-type-metric">2</p></div><div className="px-2 text-center"><p className="ov-type-caption text-muted-foreground">Disaster</p><p className="ov-type-metric">1</p></div></div></div>
            <div className="grid gap-3 lg:grid-cols-[3fr_2fr]"><div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Alertas recentes</SectionAccentTitle><p className="mt-2 ov-type-secondary text-muted-foreground">OperationalList · cliente · host · problema · severidade · duração</p></div><div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Chamados</SectionAccentTitle><p className="mt-2 ov-type-secondary text-muted-foreground">IncidentQueue · tabs · prioridade · status</p></div></div>
            <div className="grid gap-3 lg:grid-cols-[1fr_2fr]"><div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Links de operadoras</SectionAccentTitle><p className="mt-2 ov-type-secondary text-muted-foreground">Conectividade que também exige ação.</p></div><div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Eventos recentes</SectionAccentTitle><p className="mt-2 ov-type-secondary text-muted-foreground">Contexto operacional sem competir com a fila prioritária.</p></div></div>
          </div>
        </PatternFrame>
        <PatternFrame number="09" title="NOC Monitoring">
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><SectionAccentTitle level={1}>Monitoramento</SectionAccentTitle><p className="ov-type-secondary text-muted-foreground">Visão operacional em tempo real</p></div><OneViewHealthIndicator status="healthy" label="Health global" /></div>
            <div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><div className="flex flex-wrap items-center gap-2"><OneViewPill selected>Cliente</OneViewPill><OneViewPill>Fonte</OneViewPill><OneViewPill>2h</OneViewPill><OneViewButton variant="secondary">Mais filtros</OneViewButton></div><div className="mt-2 border-t border-border pt-2"><OneViewPill selected>Prioritários</OneViewPill><OneViewPill className="ml-2">Todos</OneViewPill></div></div>
            <div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><p className="ov-type-caption text-muted-foreground">SeverityStrip · Information · Warning · Average · High · Disaster</p></div>
            <div className="grid gap-3 lg:grid-cols-[3fr_2fr]"><div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Fila operacional</SectionAccentTitle><p className="mt-1 ov-type-secondary text-muted-foreground">Prioritários · últimas 2h · 61 na fila</p><p className="mt-3 ov-type-secondary text-muted-foreground">OperationalQueue · Cliente · Host · Problema · Severidade · ACK · Início · Duração · Ação</p></div><div className="rounded-[var(--ov-radius-surface)] border border-border bg-background p-3"><SectionAccentTitle>Chamados</SectionAccentTitle><p className="mt-1 ov-type-secondary text-muted-foreground">5 sem responsável</p><p className="mt-3 ov-type-secondary text-muted-foreground">IncidentQueue · Sem responsável · Com analista · Todos</p></div></div>
          </div>
        </PatternFrame>
      </div>
    </div>
  );
}

export function UiKitComponentsSection() {
  const [selectedPill, setSelectedPill] = useState("Todos");
  const [checked, setChecked] = useState(true);

  return (
    <div className="space-y-4">
      <OneViewPanel title="Official components" description="Use estes componentes dentro dos patterns. Não crie uma variação local parecida.">
        <div className="grid gap-4 xl:grid-cols-2">
          <div><p className="ov-type-caption font-semibold uppercase text-muted-foreground">Buttons — 4 variantes</p><div className="mt-3 flex flex-wrap gap-2"><OneViewButton>Primary</OneViewButton><OneViewButton variant="secondary">Secondary</OneViewButton><OneViewButton variant="ghost">Ghost</OneViewButton><OneViewButton variant="danger">Danger</OneViewButton></div><p className="mt-3 ov-type-caption text-muted-foreground">{Object.entries(ONEVIEW_ACTION_COLORS).map(([name, color]) => `${name}: ${color}`).join(" · ")}. Links textuais usam <OneViewTextAction>TextAction</OneViewTextAction>, não uma quinta variante.</p></div>
          <div><p className="ov-type-caption font-semibold uppercase text-muted-foreground">Control states</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><Input className="h-9 rounded-[var(--ov-radius-control)]" placeholder="Default" /><Input className="h-9 rounded-[var(--ov-radius-control)] ring-2 ring-ring ring-offset-1" value="Focus" readOnly /><Input className="h-9 rounded-[var(--ov-radius-control)]" placeholder="Disabled" disabled /></div></div>
        </div>
      </OneViewPanel>

      <div className="grid gap-4 xl:grid-cols-2">
        <OneViewPanel title="TAB ≠ PILL ≠ BADGE" description="Cada elemento possui uma responsabilidade visual e funcional.">
          <div className="space-y-5">
            <div><p className="ov-type-body font-semibold">TAB muda uma visão</p><Tabs defaultValue="down" className="mt-2"><TabsList><TabsTrigger value="down">Em falha</TabsTrigger><TabsTrigger value="normalized">Normalizados</TabsTrigger></TabsList><TabsContent value="down" className="ov-type-secondary text-muted-foreground">Conteúdo da visão selecionada.</TabsContent><TabsContent value="normalized" /></Tabs></div>
            <div><p className="ov-type-body font-semibold">PILL aplica um filtro</p><div className="mt-2 flex flex-wrap gap-2">{["Todos", "Sem chamado", "Com chamado"].map((pill) => <OneViewPill key={pill} selected={selectedPill === pill} onClick={() => setSelectedPill(pill)}>{pill}</OneViewPill>)}</div></div>
            <div><p className="ov-type-body font-semibold">BADGE mostra metadado ou estado</p><div className="mt-2 flex flex-wrap gap-2"><Badge variant="secondary">Datacenter SP</Badge><OneViewSemanticStatusBadge status="incident-progress" /><OneViewSeverityBadge severity="high" /><SemanticBadge label="Sem dot" showDot={false} className="ov-status-incident-new" /></div></div>
          </div>
        </OneViewPanel>

        <OneViewPanel title="Forms / Inputs, Select, Search & Checkbox" description="Todos os controles do mesmo contexto usam 36px e raio de 8px.">
          <div className="space-y-3"><Input className="h-9 rounded-[var(--ov-radius-control)]" placeholder="Input" /><Select defaultValue="all"><SelectTrigger className="h-9 rounded-[var(--ov-radius-control)]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos</SelectItem></SelectContent></Select><label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 rounded-[var(--ov-radius-control)] pl-9" placeholder="Search" /></label><div className="flex items-center gap-3"><Checkbox id="official-checkbox" checked={checked} onCheckedChange={(value) => setChecked(value === true)} /><label htmlFor="official-checkbox" className="ov-type-body">Checkbox</label></div></div>
        </OneViewPanel>

        <OneViewPanel title="Cards / Panels & KPI" description="Mesmo surface base: 12px, border, 16px e sem shadow.">
          <div className="ov-surface-official p-4"><p className="ov-type-section-title">Panel oficial</p><p className="mt-1 ov-type-secondary text-muted-foreground">Header opcional, descrição opcional e action opcional.</p></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><OneViewKpiCard className="ov-kpi-official" label="Total" value="102" /><OneViewKpiCard className="ov-kpi-official" label="Em falha" value="12" tone="danger" /></div>
        </OneViewPanel>

        <OneViewPanel title="Operational Table" description="Existe um único pattern oficial."><OperationalTable /></OneViewPanel>

        <OneViewPanel title="Overlay controls" description="Shadow somente em camadas elevadas.">
          <div className="flex flex-wrap gap-2"><Tooltip><TooltipTrigger asChild><OneViewButton variant="secondary" aria-label="Ajuda de filtros"><SlidersHorizontal className="h-[18px] w-[18px]" /></OneViewButton></TooltipTrigger><TooltipContent>Tooltip curto</TooltipContent></Tooltip><DropdownMenu><DropdownMenuTrigger asChild><OneViewButton variant="secondary">Dropdown <ChevronDown className="ml-2 h-[18px] w-[18px]" /></OneViewButton></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuLabel>Ações</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem>Ver detalhes</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Dialog><DialogTrigger asChild><OneViewButton variant="secondary">Modal</OneViewButton></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Confirmar ação</DialogTitle><DialogDescription>Confirmação curta e contextual.</DialogDescription></DialogHeader><DialogFooter><OneViewButton>Confirmar</OneViewButton></DialogFooter></DialogContent></Dialog><Sheet><SheetTrigger asChild><OneViewButton variant="secondary">Drawer</OneViewButton></SheetTrigger><SheetContent><SheetHeader><SheetTitle>Detalhe operacional</SheetTitle><SheetDescription>Header, content sections e action area.</SheetDescription></SheetHeader><div className="my-6 ov-surface-official p-4 ov-type-body">Seção do drawer</div><SheetFooter><OneViewButton>Concluir</OneViewButton></SheetFooter></SheetContent></Sheet></div>
        </OneViewPanel>

        <OneViewPanel title="Feedback / Loading / Empty State / Health" description="Feedback combina ícone, indicador, border, título e descrição; nunca depende somente de cor.">
          <div className="space-y-4">
            <div className="grid gap-2">
              <OneViewFeedback tone="success" title="Success message" description="Operação concluída com confirmação textual." />
              <OneViewFeedback tone="warning" title="Warning message" description="Há uma condição que exige atenção." />
              <OneViewFeedback tone="error" title="Error message" description="A operação não foi concluída." />
              <OneViewFeedback tone="info" title="Info message" description="Contexto tecnológico ou informacional." />
            </div>
            <div className="space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-12 w-full rounded-[var(--ov-radius-surface)]" /></div>
            <div className="flex flex-col items-center border-y border-border py-4 text-center"><Inbox className="h-6 w-6 text-muted-foreground" /><p className="mt-2 ov-type-body font-semibold">Nenhum item encontrado</p><p className="ov-type-caption text-muted-foreground">Ajuste os filtros para ampliar a busca.</p></div>
            <div className="flex flex-wrap gap-4"><OneViewHealthIndicator status="healthy" label="OneView saudável" /><OneViewHealthIndicator status="degraded" label="ServiceNow degradado" /></div>
          </div>
        </OneViewPanel>
      </div>
    </div>
  );
}

export function UiKitTemplatesSection() {
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {TEMPLATE_DEFINITIONS.map((template) => (
        <OneViewPanel key={template.title} title={template.title} description={template.description} className="min-h-[18rem]">
          <div className="grid min-h-48 grid-cols-3 gap-2 rounded-[var(--ov-radius-surface)] border border-border bg-muted/20 p-3">
            {template.blocks.map((block, index) => <div key={`${block}-${index}`} className={cn("rounded-[var(--ov-radius-control)] border border-border bg-background p-2", index === 0 || block === "table" || block === "queue" ? "col-span-full" : "")}><p className="ov-type-caption capitalize text-muted-foreground">{block}</p><div className="mt-3 h-1.5 w-4/5 rounded-[var(--ov-radius-pill)] bg-muted" /></div>)}
          </div>
          <p className="mt-3 ov-type-caption text-muted-foreground">Preview estrutural baseado em patterns oficiais.</p>
        </OneViewPanel>
      ))}
    </div>
  );
}

export function UiKitSemanticStatesSection() {
  return (
    <div className="space-y-4">
      <OneViewPanel title="OLD / V1.1" description="Status v1.1 mantém texto e adiciona soft background, border e dot de 6px.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[var(--ov-radius-surface)] border border-dashed border-border p-4"><p className="ov-type-caption font-semibold uppercase text-muted-foreground">OLD</p><p className="mt-3 ov-type-body text-[hsl(var(--ov-color-danger))]">Em falha</p><p className="mt-2 ov-type-caption text-muted-foreground">Texto colorido isolado.</p></div>
          <div className="rounded-[var(--ov-radius-surface)] border border-border p-4"><p className="ov-type-caption font-semibold uppercase text-[hsl(var(--ov-color-accent-blue))]">V1.1</p><div className="mt-3"><OneViewSemanticStatusBadge status="monitoring-down" /></div><p className="mt-2 ov-type-caption text-muted-foreground">Foreground forte + surface leve + border + dot.</p></div>
        </div>
      </OneViewPanel>
      <OneViewPanel title="Status semântico" description="Foreground, soft background e border explícitos; contraste mínimo de 4.5:1 para texto normal.">
        <div className="grid gap-5 lg:grid-cols-3">{STATUS_GROUPS.map((group) => <div key={group.title}><h3 className="mb-3 ov-type-section-title">{group.title}</h3><div className="flex flex-wrap gap-2">{group.statuses.map((status) => <OneViewSemanticStatusBadge key={status} status={status} />)}</div></div>)}</div><p className="mt-5 border-t border-border pt-4 ov-type-caption text-muted-foreground">{Object.keys(ONEVIEW_STATUS_CATALOG).length} estados operacionais oficiais.</p>
      </OneViewPanel>
      <OneViewPanel title="Severity" description="Severidade é distinta do monitoramento e do estado do INC."><div className="flex flex-wrap gap-2">{Object.keys(ONEVIEW_SEVERITY_CATALOG).map((severity) => <OneViewSeverityBadge key={severity} severity={severity as keyof typeof ONEVIEW_SEVERITY_CATALOG} />)}</div></OneViewPanel>
      <div className="grid gap-4 xl:grid-cols-2">
        <OneViewPanel title="DO" description="Neutral surface first."><div className="ov-surface-official flex items-center justify-between gap-3 p-4"><div><p className="ov-type-body font-semibold">Cliente · Unidade principal</p><p className="ov-type-caption text-muted-foreground">Falha detectada há 8 min</p></div><OneViewSemanticStatusBadge status="monitoring-down" /></div></OneViewPanel>
        <OneViewPanel title="DON'T" description="Estado não deve dominar a superfície."><div className="rounded-[var(--ov-radius-surface)] border border-dashed border-[hsl(var(--ov-color-danger)/0.45)] bg-muted/30 p-4"><p className="ov-type-body font-semibold">Não pinte o card inteiro</p><p className="mt-1 ov-type-caption text-muted-foreground">Sem gradient decorativo, shadow de card ou rounded-full em controles.</p></div></OneViewPanel>
      </div>
    </div>
  );
}
