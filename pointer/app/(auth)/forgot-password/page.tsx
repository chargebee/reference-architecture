"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { authClient } from "@/lib/auth-client";

import {
	AuthHeading,
	ErrorText,
	Field,
	Input,
	SubmitButton,
	SuccessText,
} from "../_components/form-ui";

export default function ForgotPasswordPage() {
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setInfo(null);
		setPending(true);

		const formData = new FormData(event.currentTarget);
		const email = String(formData.get("email") ?? "");

		const { error: requestError } = await authClient.requestPasswordReset({
			email,
			redirectTo: "/reset-password",
		});

		setPending(false);

		if (requestError) {
			setError(requestError.message ?? "Unable to send reset email");
			return;
		}

		setInfo(
			"If an account exists for that email, a reset link has been sent. Check the dev console.",
		);
	}

	return (
		<>
			<AuthHeading
				title="Forgot password"
				subtitle="We'll email you a link to reset it."
			/>

			<form className="space-y-4" onSubmit={onSubmit} noValidate>
				<Field label="Email" htmlFor="email">
					<Input
						id="email"
						name="email"
						type="email"
						autoComplete="email"
						required
					/>
				</Field>

				<ErrorText>{error}</ErrorText>
				<SuccessText>{info}</SuccessText>

				<SubmitButton pending={pending}>Send reset link</SubmitButton>
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
