interface KpiCardProps {
  title: string;
  value: string | number;
  icon?: React.ReactNode;
}

export function KpiCard({ title, value, icon }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-sm text-muted-foreground mb-1">{title}</p>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
        </div>
        {icon && (
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center text-foreground">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
