import { useMemo, useState } from "react";
import { History } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const EVENT_TYPES = [
  { value: "all", label: "Todos os tipos" },
  { value: "problem", label: "Problema" },
  { value: "recovery", label: "Recovery" },
  { value: "acknowledgement", label: "Reconhecimento" },
  { value: "update", label: "Atualização" },
] as const;

const PERIOD_PRESETS = [
  { value: "24h", label: "Últimas 24 h" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "custom", label: "Personalizado" },
] as const;

/**
 * Shell da página de histórico operacional.
 * Não há endpoint BFF de lista global de alert_history — filtros e empty state
 * apenas preparam a UI até a consulta server-side existir.
 */
export default function HistoricoPage() {
  const [cliente, setCliente] = useState("all");
  const [fonte, setFonte] = useState("all");
  const [eventType, setEventType] = useState<string>("all");
  const [period, setPeriod] = useState<string>("7d");
  const [search, setSearch] = useState("");

  const filterSummary = useMemo(() => {
    const parts = [
      cliente === "all" ? "Todos os clientes" : `Cliente: ${cliente}`,
      fonte === "all" ? "Todas as fontes" : `Fonte: ${fonte}`,
      EVENT_TYPES.find((item) => item.value === eventType)?.label ?? "Tipo",
      PERIOD_PRESETS.find((item) => item.value === period)?.label ?? "Período",
    ];
    if (search.trim()) parts.push(`Busca: ${search.trim()}`);
    return parts.join(" · ");
  }, [cliente, eventType, fonte, period, search]);

  const clearFilters = () => {
    setCliente("all");
    setFonte("all");
    setEventType("all");
    setPeriod("7d");
    setSearch("");
  };

  return (
    <AppLayout
      title="Histórico"
      description="Linha do tempo operacional via alert_history"
      enableAutoRefresh={false}
      showRefreshMeta={false}
    >
      <div className="space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Histórico operacional</h1>
            <p className="text-sm text-muted-foreground">
              Consulta global de eventos será servida pelo BFF a partir de <code className="text-xs">alert_history</code>.
            </p>
          </div>
          <Badge variant="outline" className="text-[10px]">Em preparação</Badge>
        </header>

        <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="historico-cliente">Cliente</Label>
              <Select value={cliente} onValueChange={setCliente}>
                <SelectTrigger id="historico-cliente" aria-label="Filtrar por cliente">
                  <SelectValue placeholder="Cliente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os clientes</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="historico-fonte">Fonte</Label>
              <Select value={fonte} onValueChange={setFonte}>
                <SelectTrigger id="historico-fonte" aria-label="Filtrar por fonte">
                  <SelectValue placeholder="Fonte" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as fontes</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="historico-tipo">Tipo de evento</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger id="historico-tipo" aria-label="Filtrar por tipo de evento">
                  <SelectValue placeholder="Tipo de evento" />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="historico-periodo">Período</Label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger id="historico-periodo" aria-label="Filtrar por período">
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_PRESETS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="historico-busca">Busca</Label>
              <Input
                id="historico-busca"
                aria-label="Buscar no histórico"
                placeholder="Host, problema, ator…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{filterSummary}</p>
            <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
              Limpar filtros
            </Button>
          </div>
        </Card>

        <Card className="rounded-[10px] border border-dashed border-border/80 bg-muted/20 px-6 py-14 text-center shadow-none">
          <div className="mx-auto flex max-w-lg flex-col items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm">
              <History className="h-5 w-5" />
            </span>
            <h2 className="text-base font-semibold">Lista global em preparação</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              A listagem global de histórico operacional usará <strong>alert_history</strong> no servidor.
              Esta página não inventa linhas nem chama endpoints incompletos — o histórico por alerta
              continua disponível no drawer de Alertas.
            </p>
          </div>
        </Card>
      </div>
    </AppLayout>
  );
}
