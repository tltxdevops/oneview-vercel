import { useCallback } from "react";
import { OneViewTableSearchField } from "@/components/oneview/OneViewTableSearchField";
import {
  fetchIncidentSearchSuggestions,
  type FetchIncidentSearchSuggestionsParams,
  type OneViewSearchSuggestion,
} from "@/lib/oneview-api";

type ChamadosSearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onSelect: (value: string) => void;
  onSuggestionSelect?: (item: OneViewSearchSuggestion) => void;
  scope: Omit<FetchIncidentSearchSuggestionsParams, "q" | "limit" | "signal">;
  className?: string;
  inputId?: string;
  activity?: "idle" | "pending" | "searching";
  activityQuery?: string;
  selectedCompanies?: string[];
};

export function ChamadosSearchField({
  value,
  onChange,
  onSubmit,
  onSelect,
  onSuggestionSelect,
  scope,
  className,
  inputId = "chamados-search",
  activity,
  activityQuery,
  selectedCompanies = [],
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
      onSuggestionSelect={onSuggestionSelect}
      fetchSuggestions={fetchSuggestions}
      placeholder="Buscar na tabela por INC, cliente ou descrição…"
      ariaLabel="Buscar na tabela de chamados"
      inputId={inputId}
      className={className}
      activity={activity}
      activityQuery={activityQuery}
      getSuggestionActionLabel={(item) => item.kind === "company" ? "Aplicar Cliente" : null}
      isSuggestionSelected={(item) => item.kind === "company" && selectedCompanies.some((company) => (
        item.value.trim().toLocaleLowerCase("pt-BR") === company.trim().toLocaleLowerCase("pt-BR")
      ))}
    />
  );
}
