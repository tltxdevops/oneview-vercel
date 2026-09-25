import { useCallback } from "react";
import { OneViewTableSearchField } from "@/components/oneview/OneViewTableSearchField";
import {
  fetchIncidentSearchSuggestions,
  type FetchIncidentSearchSuggestionsParams,
} from "@/lib/oneview-api";

type ChamadosSearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onSelect: (value: string) => void;
  scope: Omit<FetchIncidentSearchSuggestionsParams, "q" | "limit" | "signal">;
  className?: string;
  inputId?: string;
};

export function ChamadosSearchField({
  value,
  onChange,
  onSubmit,
  onSelect,
  scope,
  className,
  inputId = "chamados-search",
}: ChamadosSearchFieldProps) {
  const fetchSuggestions = useCallback(
    (q: string, signal: AbortSignal) =>
      fetchIncidentSearchSuggestions({ ...scope, q, limit: 12, signal }).then((response) => response.suggestions ?? []),
    [scope],
  );

  return (
    <OneViewTableSearchField
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      onSelect={onSelect}
      fetchSuggestions={fetchSuggestions}
      placeholder="Buscar na tabela por INC, cliente ou descrição…"
      ariaLabel="Buscar na tabela de chamados"
      inputId={inputId}
      className={className}
    />
  );
}
