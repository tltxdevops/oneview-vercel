/**
 * SN-P0-23 — deep link externo para ServiceNow DEV.
 * Abre o incidente no browser do usuário. OneView não faz login SN nem envia credenciais ao navegador.
 */
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const SERVICENOW_DEV_LINK_LABEL = "Abrir no ServiceNow DEV";
export const SERVICENOW_DEV_LINK_TOOLTIP = "Requer acesso ao ServiceNow DEV.";

type ServiceNowDevLinkProps = {
  href: string;
  className?: string;
  size?: "default" | "sm" | "lg" | "icon";
  fullWidth?: boolean;
};

export function ServiceNowDevLink({
  href,
  className,
  size = "default",
  fullWidth = false,
}: ServiceNowDevLinkProps) {
  const url = String(href || "").trim();
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
              title={SERVICENOW_DEV_LINK_TOOLTIP}
            >
              <ExternalLink className="h-4 w-4" />
              {SERVICENOW_DEV_LINK_LABEL}
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{SERVICENOW_DEV_LINK_TOOLTIP}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
