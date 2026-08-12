import { getPool } from "@/lib/db";
import { syncSubscriptionEntitlements } from "@/lib/entitlements/sync";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(
    prefix.length,
  );
}

async function main() {
  const selected = option("subscription");
  const pool = await getPool();
  const result = await pool.query<{ chargebeeSubscriptionId: string }>(
    `SELECT "chargebeeSubscriptionId"
       FROM subscription
      WHERE status = ANY($1)
        AND "chargebeeSubscriptionId" IS NOT NULL
        AND ($2::text IS NULL OR "chargebeeSubscriptionId" = $2)
      ORDER BY "chargebeeSubscriptionId"`,
    [["active", "in_trial", "non_renewing"], selected ?? null],
  );

  let synced = 0;
  for (const row of result.rows) {
    await syncSubscriptionEntitlements(row.chargebeeSubscriptionId, {
      trigger: "reconcile",
    });
    synced += 1;
    console.log(
      `[entitlements] reconciled ${row.chargebeeSubscriptionId} (${synced}/${result.rowCount})`,
    );
  }
  console.log(`[entitlements] reconciliation complete: ${synced} subscription(s)`);
  await pool.end();
}

main().catch((error) => {
  console.error("[entitlements] reconciliation failed", error);
  process.exitCode = 1;
});
