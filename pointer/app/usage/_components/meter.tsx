export type LimitValue = number | "unlimited";

export function formatLimit(value: LimitValue): string {
  return value === "unlimited" ? "Unlimited" : value.toLocaleString();
}

export function Meter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: LimitValue;
}) {
  const percent =
    limit === "unlimited" || limit === 0
      ? 0
      : Math.min(100, Math.round((used / limit) * 100));
  const color =
    percent >= 100
      ? "bg-red-500"
      : percent >= 80
        ? "bg-amber-500"
        : "bg-[#6E56CF]";
  return (
    <div>
      <div className="flex justify-between gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()} / {formatLimit(limit)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
