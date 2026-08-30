import Link from "next/link";

import { usageRanges, type UsageRangeKey } from "@/lib/usage/ranges";

/**
 * Range state lives in the URL rather than component state, so the page stays a
 * server component and a range is shareable.
 */
export function RangeTabs({ active }: { active: UsageRangeKey }) {
  return (
    <div role="tablist" aria-label="Usage range" className="flex flex-wrap gap-2">
      {usageRanges.map((range) => {
        const selected = range.key === active;
        return (
          <Link
            key={range.key}
            href={`/usage?range=${range.key}`}
            role="tab"
            aria-selected={selected}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              selected
                ? "border-[#6E56CF] bg-[#6E56CF] text-white"
                : "border-zinc-200 text-zinc-600 hover:border-[#6E56CF] hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {range.label}
          </Link>
        );
      })}
    </div>
  );
}
