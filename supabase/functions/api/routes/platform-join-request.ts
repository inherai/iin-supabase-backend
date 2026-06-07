import { Hono } from "https://deno.land/x/hono/mod.ts";
import { supabaseAdmin } from "../middleware.ts";

const app = new Hono();

const ADMIN_EMAIL = "contact@duallin.com";

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

async function sendAdminNotification(req: JoinRequestPayload): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return;

  const isCandidate = req.type === "candidate";
  const c = req as CandidatePayload;
  const r = req as RecruiterPayload;

  const typeLabel = isCandidate ? "מועמדת / Candidate" : "מגייסת / Recruiter";
  const subject = isCandidate
    ? `New Candidate Join Request — ${req.full_name}`
    : `New Recruiter Access Request — ${req.full_name}`;

  const specificRows = isCandidate
    ? `
      <tr style="border-top:1px solid #eee">
        <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Current Role</td>
        <td style="padding:8px 12px">${c.job_title || "—"}</td>
      </tr>
      <tr style="border-top:1px solid #eee">
        <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Experience</td>
        <td style="padding:8px 12px">${c.years_experience || "—"}</td>
      </tr>`
    : `
      <tr style="border-top:1px solid #eee">
        <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Company</td>
        <td style="padding:8px 12px">${r.company_name}</td>
      </tr>
      <tr style="border-top:1px solid #eee">
        <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Company Size</td>
        <td style="padding:8px 12px">${r.company_size || "—"}</td>
      </tr>
      <tr style="border-top:1px solid #eee">
        <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Roles Sought</td>
        <td style="padding:8px 12px">${r.roles_looking_for || "—"}</td>
      </tr>`;

  const html = `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"/></head>
    <body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f0fa;">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(75,21,76,0.12);">
        <div style="background:linear-gradient(135deg,#2d0838,#4b154c);padding:28px 32px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:2px">Duallin · Platform Access</p>
          <h1 style="margin:0;font-size:22px;font-weight:800;color:#fff">${subject}</h1>
          <span style="display:inline-block;margin-top:10px;background:rgba(255,255,255,0.15);color:#fff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:50px;letter-spacing:1px">${typeLabel}</span>
        </div>
        <div style="padding:24px 32px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr>
              <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Full Name</td>
              <td style="padding:8px 12px">${req.full_name}</td>
            </tr>
            <tr style="border-top:1px solid #eee">
              <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Email</td>
              <td style="padding:8px 12px"><a href="mailto:${req.email}" style="color:#762277">${req.email}</a></td>
            </tr>
            <tr style="border-top:1px solid #eee">
              <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap">Phone</td>
              <td style="padding:8px 12px">${req.phone}</td>
            </tr>
            ${specificRows}
            <tr style="border-top:1px solid #eee">
              <td style="padding:8px 12px;font-weight:600;color:#555;white-space:nowrap;vertical-align:top">Message</td>
              <td style="padding:8px 12px">${req.message || "—"}</td>
            </tr>
          </table>
        </div>
        <div style="padding:16px 32px;background:#faf5ff;border-top:1px solid #ede0f0;font-size:11px;color:#999;text-align:center">
          Sent from duallin.com · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>
    </body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Duallin System <noreply@duallin.com>",
      to: [ADMIN_EMAIL],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    console.error("Resend error:", await res.text());
  }
}

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

    const r = body as RecruiterPayload;
    const ca = body as CandidatePayload;

    const { error: dbError } = await supabaseAdmin.from("platform_join_requests").insert({
      type: body.type,
      full_name: body.full_name.trim(),
      email: body.email.trim().toLowerCase(),
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

    // Fire-and-forget email notification
    sendAdminNotification(body).catch((err) =>
      console.error("Admin notification failed:", err)
    );

    return c.json({ success: true });
  } catch (err: any) {
    console.error("Platform join request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
