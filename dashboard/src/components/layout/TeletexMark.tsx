import { cn } from "@/lib/utils";

type TeletexMarkProps = {
  className?: string;
  inverted?: boolean;
};

export function TeletexMark({ className, inverted = false }: TeletexMarkProps) {
  return (
    <img
      src="/tltx/tltx-t-branco.png?v=4"
      alt="TLTX"
      width={28}
      height={28}
      className={cn(
        "h-7 w-7 shrink-0 select-none object-contain",
        inverted && "invert",
        className,
      )}
      draggable={false}
    />
  );
}
