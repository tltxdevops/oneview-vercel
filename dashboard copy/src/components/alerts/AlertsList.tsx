import { Alert } from "@/types";
import { AlertItem } from "./AlertItem";
import { AlertCircle } from "lucide-react";

interface AlertsListProps {
  alerts: Alert[];
  sampleNeeded?: boolean;
}

export function AlertsList({ alerts, sampleNeeded = false }: AlertsListProps) {
  // preserve incoming order by default (sorting handled upstream)
  const ordered = alerts;

  if (sampleNeeded) {
    // render only an invisible sample item for measurement
    const sample = alerts[0] ?? {
      id: "SAMPLE",
      time: "00:00:00",
      severity: "Info",
      host: "SAMPLE-HOST",
      problem: "Sample",
      operationalData: "",
      duration: "0s",
      status: "Active",
      tags: [],
      clientId: undefined,
      clientName: undefined,
    };

    return (
      <div>
        <ul className="flex flex-col gap-2">
          <li data-sample className="invisible pointer-events-none">
            <AlertItem alert={sample} />
          </li>
        </ul>
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-[10px] bg-white p-8 text-center">
        <AlertCircle className="mb-4 h-12 w-12 text-muted-foreground" />
        <h3 className="mb-2 text-lg font-semibold">Sem alertas recentes</h3>
        <p className="text-sm text-muted-foreground">Nenhum alerta nas últimas 24 horas</p>
      </div>
    );
  }

  return (
    <div>
      <ul className="flex flex-col gap-2">
        {ordered.map((a) => (
          <li key={a.id}>
            <AlertItem alert={a} />
          </li>
        ))}
      </ul>
    </div>
  );
}
