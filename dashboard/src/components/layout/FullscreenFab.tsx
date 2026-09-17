import { useCallback, useEffect, useState } from "react";
import { Expand, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FullscreenFab() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen pode ser bloqueado pelo navegador; a tela permanece utilizável.
    }
  }, []);

  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="ov-fullscreen-fab"
      onClick={() => void toggleFullscreen()}
      aria-label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
      aria-pressed={isFullscreen}
      title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
    >
      {isFullscreen
        ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
        : <Expand className="h-4 w-4" aria-hidden="true" />}
    </Button>
  );
}
