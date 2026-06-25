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
  SuccessText,
} from "../_components/form-ui";

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setInfo(null);

    if (!token) {
      setError("Missing or invalid reset token.");
      return;
    }

    setPending(true);

    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");

    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    setPending(false);

    if (resetError) {
      setError(resetError.message ?? "Unable to reset password");
      return;
    }

    setInfo("Password updated. Redirecting to sign in…");
    setTimeout(() => router.push("/sign-in"), 1200);
  }

  if (!token) {
    return (
      <ErrorText>
        This link is missing a token. Request a new reset email.
      </ErrorText>
    );
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <Field label="New password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
        />
      </Field>

      <ErrorText>{error}</ErrorText>
      <SuccessText>{info}</SuccessText>

      <SubmitButton pending={pending}>Update password</SubmitButton>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <AuthHeading
        title="Reset password"
        subtitle="Choose a new password for your account."
      />

      <Suspense fallback={<div className="h-32" />}>
        <ResetPasswordForm />
      </Suspense>

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
