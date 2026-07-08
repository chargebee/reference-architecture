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

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "");
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    // Email verification is disabled — Better Auth signs the user in
    // immediately and the session cookie is set, so we send them to plan
    // selection before the dashboard.
    const { error: signUpError } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: "/choose-plan",
    });

    if (signUpError) {
      setPending(false);
      setError(signUpError.message ?? "Unable to sign up");
      return;
    }

    router.push("/choose-plan");
    router.refresh();
  }

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
