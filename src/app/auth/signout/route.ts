import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
export async function POST(request: Request) { if (process.env.NEXT_PUBLIC_DEMO_MODE !== "true") { const supabase = await createClient(); await supabase.auth.signOut(); } return NextResponse.redirect(new URL("/auth/login", request.url), 303); }
