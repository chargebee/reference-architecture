"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { authClient } from "@/lib/auth-client";

import {
  AuthHeading,
  ErrorText,
  Field,
  Input,
  SubmitButton,
} from "../_components/form-ui";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get("from") ?? "/";

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    const { data, error: signInError } = await authClient.signIn.email({
      email,
      password,
      callbackURL: callbackUrl,
    });

    if (signInError) {
      setPending(false);
      setError(signInError.message ?? "Unable to sign in");
      return;
    }

    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      router.push("/two-factor");
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  }

  return (
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

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      <ErrorText>{error}</ErrorText>

      <SubmitButton pending={pending}>Sign in</SubmitButton>
    </form>
  );
}

export default function SignInPage() {
  return (
    <>
      <AuthHeading
        title="Sign in"
        subtitle={
          <>
            New here?{" "}
            <Link
              href="/sign-up"
              className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100"
            >
              Create an account
            </Link>
          </>
        }
      />

      <Suspense fallback={<div className="h-48" />}>
        <SignInForm />
      </Suspense>

      <p className="mt-4 text-center text-sm">
        <Link
          href="/forgot-password"
          className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Forgot password?
        </Link>
      </p>
    </>
  );
}
