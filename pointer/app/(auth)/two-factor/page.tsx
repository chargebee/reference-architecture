"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { authClient } from "@/lib/auth-client";

import {
	AuthHeading,
	ErrorText,
	Field,
	Input,
	SubmitButton,
} from "../_components/form-ui";

export default function TwoFactorPage() {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setPending(true);

		const formData = new FormData(event.currentTarget);
		const code = String(formData.get("code") ?? "");

		const { error: verifyError } = await authClient.twoFactor.verifyTotp({
			code,
		});

		setPending(false);

		if (verifyError) {
			setError(verifyError.message ?? "Invalid code");
			return;
		}

		router.push("/");
		router.refresh();
	}

	return (
		<>
			<AuthHeading
				title="Two-factor authentication"
				subtitle="Enter the 6-digit code from your authenticator app."
			/>

			<form className="space-y-4" onSubmit={onSubmit} noValidate>
				<Field label="Code" htmlFor="code">
					<Input
						id="code"
						name="code"
						type="text"
						inputMode="numeric"
						autoComplete="one-time-code"
						pattern="[0-9]{6}"
						maxLength={6}
						required
					/>
				</Field>

				<ErrorText>{error}</ErrorText>

				<SubmitButton pending={pending}>Verify</SubmitButton>
			</form>

			<p className="mt-4 text-center text-sm">
				<Link
					href="/sign-in"
					className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
				>
					Back to sign in
				</Link>
			</p>
		</>
	);
}
