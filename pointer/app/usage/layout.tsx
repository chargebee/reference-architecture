import { AppHeader } from "@/app/_components/app-header";

/**
 * The header lives here rather than in the page so it survives a range switch:
 * `loading.tsx` only replaces what is below it.
 */
export default function UsageLayout({ children }: LayoutProps<"/usage">) {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <AppHeader active="/usage" />
      {children}
    </div>
  );
}
