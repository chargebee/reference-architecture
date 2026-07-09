"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

export type InfoBubbleLink = {
  label: string;
  href: string;
  /** Opens in a new tab. Defaults to true for absolute (http) URLs. */
  external?: boolean;
  description?: string;
};

type Align = "start" | "end";

export function InfoBubble({
  links,
  title = "How-to guides",
  label = "Show related how-to guides",
  align = "end",
  className = "",
}: {
  links: InfoBubbleLink[];
  /** Heading shown at the top of the expanded panel. */
  title?: string;
  /** Accessible label for the trigger button. */
  label?: string;
  /** Horizontal edge the panel is anchored to. */
  align?: Align;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`inline-flex ${className}`}>
      <div className="relative inline-flex">
        <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 cursor-help items-center justify-center overflow-hidden rounded-full bg-white p-[3px] shadow-md ring-1 ring-black/10 transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6E56CF] focus-visible:ring-offset-1 dark:bg-white dark:ring-white/15 dark:focus-visible:ring-offset-zinc-950"
      >
        <Image
          src="/pointer-favicon-circle.svg"
          alt=""
          width={28}
          height={28}
          className="h-full w-full rounded-full"
          aria-hidden
        />
      </button>

      {open ? (
        <div
          id={panelId}
          role="menu"
          className={`absolute top-full z-20 mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-lg ring-1 ring-black/5 dark:border-zinc-800 dark:bg-zinc-900 dark:ring-white/10 ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {title ? (
            <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {title}
            </p>
          ) : null}
          <ul className="flex flex-col">
            {links.map((link) => {
              const isExternal =
                link.external ?? /^https?:\/\//.test(link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    role="menuitem"
                    target={isExternal ? "_blank" : undefined}
                    rel={isExternal ? "noopener noreferrer" : undefined}
                    onClick={() => setOpen(false)}
                    className="group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <span className="mt-0.5 text-zinc-400 group-hover:text-[#6E56CF] dark:group-hover:text-[#8b73e0]">
                      {isExternal ? "↗" : "→"}
                    </span>
                    <span className="flex flex-col">
                      <span className="font-medium">{link.label}</span>
                      {link.description ? (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {link.description}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      </div>
    </div>
  );
}
