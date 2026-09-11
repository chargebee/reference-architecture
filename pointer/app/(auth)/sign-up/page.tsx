"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { authClient } from "@/lib/auth-client";
import { findSelfServicePlan } from "@/lib/self-service-plans";

import {
	AuthHeading,
	ErrorText,
	Field,
	Input,
	SubmitButton,
} from "../_components/form-ui";

function SignUpForm() {
	const router = useRouter();
	const params = useSearchParams();
	const selectedPlan = findSelfServicePlan(params.get("plan") ?? undefined);

	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	// A paid choice rides along to the home page, which hands off to Chargebee
	// once the free subscription every account starts on has been provisioned.
	const callbackURL = selectedPlan?.paid
		? `/?provisioning=1&plan=${selectedPlan.id}`
		: "/?provisioning=1";

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setPending(true);

		const formData = new FormData(event.currentTarget);
		const name = String(formData.get("name") ?? "");
		const email = String(formData.get("email") ?? "");
		const password = String(formData.get("password") ?? "");

		// Email verification is disabled, so Better Auth signs the user in
		// immediately. The home page waits for the automatically-created free
		// subscription webhook and entitlement mirror before rendering.
		const { error: signUpError } = await authClient.signUp.email({
			name,
			email,
			password,
			callbackURL,
		});

		if (signUpError) {
			setPending(false);
			setError(signUpError.message ?? "Unable to sign up");
			return;
		}

		router.push(callbackURL);
		router.refresh();
	}

	return (
		<>
			{selectedPlan?.paid ? (
				<p className="mb-6 rounded-lg border border-[#6E56CF]/20 bg-[#6E56CF]/[.06] px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
					You picked{" "}
					<span className="font-medium text-[#6E56CF]">
						{selectedPlan.name}
					</span>{" "}
					at {selectedPlan.priceLabel}
					{selectedPlan.cadence}. We&apos;ll take you to Chargebee checkout
					right after your account is created.
				</p>
			) : null}

			<form className="space-y-4" onSubmit={onSubmit} noValidate>
				<Field label="Name" htmlFor="name">
					<Input
						id="name"
						name="name"
						type="text"
						autoComplete="name"
						required
					/>
				</Field>

				<Field label="Email" htmlFor="email">
					<Input
						id="email"
						name="email"
						type="email"
						autoComplete="email"
						required
					/>
				</Field>

				<Field label="Password" htmlFor="password">
					<Input
						id="password"
						name="password"
						type="password"
						autoComplete="new-password"
						required
					/>
				</Field>

				<ErrorText>{error}</ErrorText>

				<SubmitButton pending={pending}>Create account</SubmitButton>
			</form>
		</>
	);
}

export default function SignUpPage() {
	return (
		<>
			<AuthHeading
				title="Create your account"
				subtitle={
					<>
						Already have one?{" "}
						<Link
							href="/sign-in"
							className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100"
						>
							Sign in
						</Link>
					</>
				}
			/>

			<Suspense fallback={<div className="h-64" />}>
				<SignUpForm />
			</Suspense>
		</>
	);
}
