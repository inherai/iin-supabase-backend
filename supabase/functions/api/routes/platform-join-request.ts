import { Hono } from "https://deno.land/x/hono/mod.ts";
import { supabaseAdmin } from "../middleware.ts";
import { sendJoinRequestReceived } from '../lib/emails/service.ts';

const app = new Hono();

interface CandidatePayload {
  type: "candidate";
  full_name: string;
  email: string;
  phone: string;
  job_title?: string;
  years_experience?: string;
  message?: string;
}

interface RecruiterPayload {
  type: "recruiter";
  full_name: string;
  email: string;
  phone: string;
  company_name: string;
  company_size?: string;
  roles_looking_for?: string;
  message?: string;
}

type JoinRequestPayload = CandidatePayload | RecruiterPayload;

app.post("/", async (c) => {
  try {
    const body = await c.req.json() as JoinRequestPayload;

    if (!body.type || !body.full_name?.trim() || !body.email?.trim() || !body.phone?.trim()) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    if (!["candidate", "recruiter"].includes(body.type)) {
      return c.json({ error: "Invalid request type" }, 400);
    }
    if (body.type === "recruiter" && !(body as RecruiterPayload).company_name?.trim()) {
      return c.json({ error: "Company name is required for recruiter requests" }, 400);
    }

    const normalizedEmail = body.email.trim().toLowerCase();

    // Check for duplicates before inserting
    const [{ data: existingUser }, { data: existingRequest }, { data: existingInvite }] = await Promise.all([
      supabaseAdmin.from("users").select("uuid").eq("email", normalizedEmail).maybeSingle(),
      supabaseAdmin.from("platform_join_requests").select("id").eq("email", normalizedEmail).maybeSingle(),
      supabaseAdmin.from("invites").select("id").eq("recipient_email", normalizedEmail).eq("status", "pending").maybeSingle(),
    ]);

    if (existingUser) return c.json({ error: "existing_user" }, 409);
    if (existingRequest) return c.json({ error: "existing_request" }, 409);
    if (existingInvite) return c.json({ error: "existing_invite" }, 409);

    const r = body as RecruiterPayload;
    const ca = body as CandidatePayload;

    const { error: dbError } = await supabaseAdmin.from("platform_join_requests").insert({
      type: body.type,
      full_name: body.full_name.trim(),
      email: normalizedEmail,
      phone: body.phone.trim(),
      message: body.message?.trim() || null,
      job_title: body.type === "candidate" ? ca.job_title?.trim() || null : null,
      years_experience: body.type === "candidate" ? ca.years_experience?.trim() || null : null,
      company_name: body.type === "recruiter" ? r.company_name?.trim() || null : null,
      company_size: body.type === "recruiter" ? r.company_size?.trim() || null : null,
      roles_looking_for: body.type === "recruiter" ? r.roles_looking_for?.trim() || null : null,
    });

    if (dbError) {
      console.error("DB insert error:", dbError);
      return c.json({ error: "Failed to save request" }, 500);
    }

    // She is asking to join herself, so an earlier "don't send me invitations" no longer applies.
    // Bounces, complaints and admin blocks stay.
    await supabaseAdmin.from("email_suppressions").delete()
      .eq("email", normalizedEmail).in("reason", ["unsubscribe_invites", "unsubscribe_all"]);

    // No email to the team: requests are stored above and reviewed in the admin backoffice
    // (/dualldmin → join requests). An alert per form only clogged the inbox and used Resend quota.

    // "We got your request" to her (email plan A5) — her own action, so it goes out right away.
    sendJoinRequestReceived({ type: body.type, full_name: body.full_name.trim(), email: normalizedEmail }).catch((err) =>
      console.error("Join request confirmation failed:", err)
    );

    return c.json({ success: true });
  } catch (err: any) {
    console.error("Platform join request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
