import { AppLayout } from "@/components/layout/AppLayout";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { PageHeader } from "@/components/oneview/PageHeader";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const FUTURE_COLUMNS = [
  "Número",
  "Estado",
  "Grupo responsável",
  "Responsável",
  "SLA",
  "Última atualização",
] as const;

export default function ChamadosPage() {
  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      showHealthStrip={false}
      contentClassName="gap-3 p-3 lg:px-4"
    >
      <div className="space-y-3">
        <PageHeader
          title="Chamados"
          description="Integração ServiceNow em preparação."
          aside={(
            <Badge variant="outline" className="text-[10px]">
              Em preparação
            </Badge>
          )}
        />

        <SectionPanel bodyClassName="space-y-2 px-6 py-5">
          <p className="text-sm text-foreground">
            A integração com o ServiceNow está em preparação.
          </p>
          <p className="text-sm text-muted-foreground">
            Os chamados relacionados aos alertas serão exibidos nesta área após a conclusão do
            contrato técnico e da integração.
          </p>
        </SectionPanel>

        <SectionPanel className="overflow-hidden border-dashed" bodyClassName="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {FUTURE_COLUMNS.map((column) => (
                  <TableHead key={column} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={FUTURE_COLUMNS.length} className="p-0">
                  <OperationalEmptyState
                    compact
                    title="Nenhum chamado disponível. Aguardando integração com o ServiceNow."
                  />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </SectionPanel>
      </div>
    </AppLayout>
  );
}
