import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Link } from "react-router-dom";

import { Chamado } from "@/types";
import { StatusBadge } from "@/components/badges/StatusBadge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface ChamadosTableProps {
  chamados: Chamado[];
  constrainHeight?: boolean;
  showViewAllButton?: boolean;
  viewAllHref?: string;
  title?: string;
  headerContent?: ReactNode;
  className?: string;
}

const formatChamadoId = (id: string) => {
  const digits = id.replace(/\D/g, "");
  return `REQ${digits.padStart(7, "0")}`;
};

export function ChamadosTable({
  chamados,
  constrainHeight = true,
  showViewAllButton = true,
  viewAllHref = "/chamados",
  title = "Chamados",
  headerContent,
  className,
}: ChamadosTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasMeasuredRef = useRef(false);
  const [maxRows, setMaxRows] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!constrainHeight) {
      setMaxRows(null);
      return;
    }

    if (hasMeasuredRef.current) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    let attempts = 0;
    const maxAttempts = 6;
    let frameId = 0;

    const measure = () => {
      attempts += 1;
      const headerRow = container.querySelector("thead tr");
      const bodyRow = container.querySelector("tbody tr");

      const cardRect = container.getBoundingClientRect();
      const available = window.innerHeight - cardRect.top - 56; // reserve extra space to avoid overflow
      const headerHeight = headerRow?.getBoundingClientRect().height ?? 0;
      const rowHeight = bodyRow?.getBoundingClientRect().height ?? 0;

      if (available > 0 && headerHeight > 0 && rowHeight > 0) {
        const rowsFit = Math.floor((available - headerHeight) / rowHeight);
        const boundedRows = Math.max(1, Number.isFinite(rowsFit) ? rowsFit : 1);
        const nextCount = Math.min(chamados.length, boundedRows);

        hasMeasuredRef.current = true;
        setMaxRows(nextCount);
        return;
      }

      if (attempts < maxAttempts) {
        frameId = window.requestAnimationFrame(measure);
      } else {
        hasMeasuredRef.current = true;
        setMaxRows((prev) => prev ?? Math.max(1, chamados.length));
      }
    };

    frameId = window.requestAnimationFrame(measure);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [chamados.length, constrainHeight]);

  const chamadosToRender = useMemo(() => {
    if (!constrainHeight || maxRows === null) {
      return chamados;
    }
    return chamados.slice(0, maxRows);
  }, [chamados, maxRows, constrainHeight]);

  return (
    <div
      ref={containerRef}
      className={cn("rounded-[10px] bg-white shadow-sm overflow-hidden", className)}
    >
      {headerContent ? (
        headerContent
      ) : (
        <div className="flex items-center justify-between px-6 py-5 border-b border-border/60 bg-white">
          <h2 className="text-lg font-semibold tracking-tight text-foreground/90">{title}</h2>
          {showViewAllButton && (
            <Button variant="ghost" size="sm" asChild>
              <Link to={viewAllHref} className="text-sm font-medium">
                Ver todos
              </Link>
            </Button>
          )}
        </div>
      )}
        <Table className="min-w-full text-sm">
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-[120px] text-xs uppercase tracking-wide text-muted-foreground/80">ID / Severidade</TableHead>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground/80">Título</TableHead>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground/80">Cliente / Responsável</TableHead>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground/80">Status</TableHead>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground/80">Data</TableHead>
            <TableHead className="w-[80px] text-center text-xs uppercase tracking-wide text-muted-foreground/80">
              Ações
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {chamadosToRender.map((chamado) => (
            <TableRow
              key={chamado.id}
              className="hover:bg-muted/40 transition-colors"
            >
              <TableCell className="font-mono text-xs text-muted-foreground/90 flex items-center gap-2">
                <span>{formatChamadoId(chamado.id)}</span>
                <SeverityBadge severity={chamado.severity} />
              </TableCell>
              <TableCell className="text-sm font-medium text-foreground/90">{chamado.title}</TableCell>
              <TableCell className="text-sm text-muted-foreground/80">
                <div className="flex items-center gap-2">
                  <span>{chamado.client}</span>
                  <span className="text-xs text-muted-foreground/70">{chamado.assignee}</span>
                </div>
              </TableCell>
              <TableCell className="py-3">
                <StatusBadge status={chamado.status} className="text-xs" />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground/70">{chamado.updatedAt}</TableCell>
              <TableCell className="text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground/80 hover:text-foreground hover:bg-muted"
                  aria-label={`Ver chamado ${chamado.id}`}
                >
                  <Eye className="h-4 w-4" />
                  <span className="sr-only">Ver detalhes</span>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
