import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function WorkspaceUnavailablePage() {
  return <main className="grid min-h-screen place-items-center p-5"><Card className="w-full max-w-md"><CardContent className="pt-7 text-center"><ShieldAlert className="mx-auto text-amber-700" size={28} aria-hidden="true" /><h1 className="mt-4 text-2xl font-black">Workspace unavailable</h1><p className="mt-2 text-[var(--muted)]">This Yield workspace is currently unavailable. Contact the Yield platform team for assistance.</p><Link href="/auth/login" className="mt-6 block"><Button variant="secondary" className="w-full">Return to login</Button></Link></CardContent></Card></main>;
}
