import { auth } from "@/lib/auth";

/**
 * Whether the current request belongs to an admin.
 *
 * Delegates to Better Auth's `userHasPermission`, which honors the admin
 * plugin's `adminUserIds` allowlist: a listed user id is treated as admin
 * regardless of its stored role. We probe an admin-only permission
 * (`user:list`) so ordinary members resolve to `false`.
 */
export async function isAdminRequest(
	requestHeaders: Headers,
): Promise<boolean> {
	const { success } = await auth.api.userHasPermission({
		headers: requestHeaders,
		body: { permissions: { user: ["list"] } },
	});
	return success;
}
