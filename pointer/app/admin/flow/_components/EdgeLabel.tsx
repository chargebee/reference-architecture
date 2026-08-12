"use client";

import { ANIMATION_MS } from "../_lib/useEventStream";

export const ANIMATION_S = ANIMATION_MS / 1000;

export function EdgeLabel({
  baseLabel,
  tag,
}: {
  baseLabel: string;
  tag?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="rounded bg-white/90 px-2 py-0.5 text-[11px] font-medium text-zinc-700 shadow-sm dark:bg-zinc-900/90 dark:text-zinc-200">
        {baseLabel}
      </span>
      {tag ? (
        <span
          key={tag}
          className="flow-tag rounded-full bg-indigo-500 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-white shadow-md"
        >
          {tag}
        </span>
      ) : null}
    </div>
  );
}
