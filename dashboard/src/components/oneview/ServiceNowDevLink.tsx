/**
 * SN-P0-23 / SN-P0-29 — deep link externo para ServiceNow.
 * Abre o incidente no browser do usuário. OneView não faz login SN nem envia credenciais ao navegador.
 * Ambiente (DEV/prod) não é hardcoded — label operacional neutro "ServiceNow".
 */
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildProductionServiceNowIncidentLink,
  canonicalizeServiceNowIncidentLink,
} from "@/lib/oneview-inc-correlation";
import { cn } from "@/lib/utils";

export const SERVICENOW_LINK_LABEL = "Abrir no ServiceNow";
export const SERVICENOW_LINK_TOOLTIP = "Requer acesso ao ServiceNow.";

/** @deprecated SN-P0-29 — use SERVICENOW_LINK_LABEL */
export const SERVICENOW_DEV_LINK_LABEL = SERVICENOW_LINK_LABEL;
/** @deprecated SN-P0-29 — use SERVICENOW_LINK_TOOLTIP */
export const SERVICENOW_DEV_LINK_TOOLTIP = SERVICENOW_LINK_TOOLTIP;

type ServiceNowDevLinkProps = {
  href?: string | null;
  sysId?: string | null;
  className?: string;
  size?: "default" | "sm" | "lg" | "icon";
  fullWidth?: boolean;
};

export function ServiceNowDevLink({
  href,
  sysId,
  className,
  size = "default",
  fullWidth = false,
}: ServiceNowDevLinkProps) {
  const url = buildProductionServiceNowIncidentLink(sysId)
    || canonicalizeServiceNowIncidentLink(href);
  if (!url) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={size}
            className={cn("gap-2", fullWidth && "w-full", className)}
            asChild
          >
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={SERVICENOW_LINK_TOOLTIP}
            >
              <ExternalLink className="h-4 w-4" />
              {SERVICENOW_LINK_LABEL}
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{SERVICENOW_LINK_TOOLTIP}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
