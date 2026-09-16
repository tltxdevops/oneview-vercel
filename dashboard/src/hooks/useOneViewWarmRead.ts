import { useEffect, useState } from "react";
import { peekOneViewReadCache } from "@/lib/oneview-api";

export function useOneViewWarmRead<T>(options: {
  cachePath: string;
  load?: () => void | Promise<void>;
}) {
  const peeked = peekOneViewReadCache<T>(options.cachePath);
  const [data] = useState<T | null>(peeked);

  useEffect(() => {
    if (!options.load) return;
    void options.load();
  }, [options.load]);

  return {
    data,
    peekHit: peeked != null,
  };
}
