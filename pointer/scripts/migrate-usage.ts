/**
 * Applies the usage archive's hand-written DDL.
 *
 * Runs *before* `@better-auth/cli migrate` (see the `db:migrate` script). On a
 * fresh database the order matters: the CLI would otherwise create an
 * unpartitioned `usage_event` and there is no in-place conversion.
 */

import { getPool } from "@/lib/db";
import { applyUsageSchema } from "@/lib/usage/partitions";
import process from "node:process";

async function main() {
	const pool = await getPool();
	await applyUsageSchema(pool);
	console.log("[usage-schema] usage_event partitions up to date");
	await pool.end();
}

main().catch((error) => {
	console.error("[usage-schema] migration failed", error);
	process.exitCode = 1;
});
