import { usageRanges } from "@/lib/usage/ranges";
import { meteredFeatures } from "@/scripts/catalog";

/** One Chargebee summary call per metered feature, so a switch is never instant. */
export default function LoadingUsage() {
	return (
		<div className="mx-auto w-full max-w-6xl animate-pulse px-6 pb-16">
			<div className="h-8 w-32 rounded-lg bg-zinc-200 dark:bg-zinc-800" />

			<div className="mt-8 flex gap-2">
				{usageRanges.map((range) => (
					<div
						key={range.key}
						className="h-7 w-24 rounded-full bg-zinc-200 dark:bg-zinc-800"
					/>
				))}
			</div>

			<div className="mt-5 grid gap-4 sm:grid-cols-2">
				{meteredFeatures.map((feature) => (
					<div
						key={feature.metric}
						className="h-56 rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
					/>
				))}
			</div>
		</div>
	);
}
