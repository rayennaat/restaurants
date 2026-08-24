"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { updatePassword } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const result = await updatePassword({ password, confirmPassword });
    if (!result.ok) {
      setLoading(false);
      setError(result.error);
      return;
    }

    setSuccess(true);
    setLoading(false);
    window.setTimeout(() => router.replace("/auth/login"), 900);
  }

  if (success) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-7 text-center shadow-sm">
          <h1 className="text-3xl font-black">Password updated</h1>
          <p className="mt-2 text-[var(--muted)]">Your password was changed successfully. Redirecting you to sign in…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-7 shadow-sm">
        <h1 className="text-3xl font-black">Set a new password</h1>
        <p className="mb-7 mt-2 text-[var(--muted)]">Choose a new password for your Yield account.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input className="border-neutral-300" id="new-password" name="password" type="password" minLength={8} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required />
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input className="border-neutral-300" id="confirm-password" name="confirmPassword" type="password" minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required />
          </div>
          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <Button className="w-full transition-shadow hover:shadow-md" disabled={loading}>{loading ? "Updating…" : "Update password"}</Button>
        </form>
        <Link href="/auth/login" className="mt-5 block text-center text-sm font-semibold text-green-800 transition hover:text-green-950 hover:underline">Back to sign in</Link>
      </div>
    </main>
  );
}
