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

export default function VerifyEmailPage() {
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

		const { error: resendError } = await authClient.sendVerificationEmail({
			email,
			callbackURL: "/",
		});

		setPending(false);

		if (resendError) {
			setError(resendError.message ?? "Unable to resend verification email");
			return;
		}

		setInfo("Verification email sent. Check the dev console for the link.");
	}

	return (
		<>
			<AuthHeading
				title="Verify your email"
				subtitle="We sent a verification link to your inbox. While email is mocked, the link is printed in the dev server console."
			/>

			<form className="space-y-4" onSubmit={onSubmit} noValidate>
				<Field
					label="Resend to"
					htmlFor="email"
					hint="Enter the email address you signed up with to resend."
				>
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

				<SubmitButton pending={pending}>Resend verification email</SubmitButton>
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
