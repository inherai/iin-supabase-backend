export interface SendInviteEmailParams {
  to: string;
  inviterName: string;
  token: string;
  personalNote?: string | null;
  expiresAt: string;
}

export async function sendInviteEmail(params: SendInviteEmailParams): Promise<void> {
  const { to, inviterName, token, personalNote, expiresAt } = params;

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }

  const appUrl = Deno.env.get('APP_URL') ?? 'https://www.duallin.com';
  const inviteUrl = `${appUrl}/invite?token=${encodeURIComponent(token)}`;

  const expiryDate = new Date(expiresAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const personalNoteHtml = personalNote
    ? personalNote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    : '';

  const personalNoteBlock = personalNote
    ? `<tr>
            <td style="padding:20px 40px 0;background:#fffcff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#f5eaff,#fdf6ff);border:1px solid #ddb8ea;border-left:4px solid #9b4aaa;border-radius:0 12px 12px 0;padding:20px 22px;">
                    <p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#762277;text-transform:uppercase;letter-spacing:1.5px;">
                      ✉ &nbsp; A note from ${inviterName}
                    </p>
                    <p style="margin:0;font-size:14px;font-weight:500;color:#3f3f46;line-height:1.8;font-style:italic;">
                      "${personalNoteHtml}"
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You've been personally invited to duallin | הוזמנת אישית לדואולין</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f0fa;padding:40px 16px;">
    <tr>
      <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(75,21,76,0.16);">


          <tr>
            <td style="background:linear-gradient(135deg,#2d0838 0%,#4b154c 55%,#380a47 100%);padding:44px 40px 36px;text-align:center;">
                <div style="display:block;background:#ffffff;border-radius:12px;padding:12px 28px;margin-bottom:22px;">
  <img src="https://www.duallin.com/assets/logotext-Dt264Rdr.png" alt="duallin" width="260" style="display:block;max-width:260px;margin: auto">
</div>

              <h1 style="margin:0 0 10px;font-size:28px;font-weight:800;color:#ffffff;line-height:1.2;letter-spacing:-0.5px;">
                Do all in. Together.
              </h1>
              <p style="margin:0;font-size:13px;font-weight:500;color:rgba(255,255,255,0.70);line-height:1.75;letter-spacing:0.2px;">
                Where Orthodox women in tech<br>
                share real insights and grow - all in.
              </p>
            </td>
          </tr>


          <tr>
            <td style="background:linear-gradient(90deg,#5a1070,#9b4aaa,#c46fd4,#9b4aaa,#5a1070);height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>


          <tr>
            <td style="padding:40px 40px 0;background:#fffcff;">


              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td align="center">
                    <span style="display:inline-block;background:linear-gradient(135deg,#5a1070,#9b4aaa);color:#ffffff;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:7px 24px;border-radius:50px;box-shadow:0 2px 12px rgba(118,34,119,0.28);">
                      ✦ &nbsp; Personal Invitation &nbsp;·&nbsp; הזמנה אישית &nbsp; ✦
                    </span>
                  </td>
                </tr>
              </table>


              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>

                  <td width="47%" valign="top" style="background:#ffffff;border:1px solid #ede0f0;border-radius:12px;padding:20px 18px;">
                    <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#9b4aaa;text-transform:uppercase;letter-spacing:1.5px;">English</p>
                    <h2 style="margin:0 0 10px;font-size:17px;font-weight:800;color:#4b154c;line-height:1.3;">
                      You've been personally invited
                    </h2>
                    <p style="margin:0;font-size:14px;font-weight:500;color:#3f3f46;line-height:1.75;">
                      <strong style="color:#4b154c;">${inviterName}</strong> thought you'd be a great fit - a trusted, exclusive network for professional Haredi women.
                    </p>
                  </td>

                  <td width="6%" style="font-size:0;">&nbsp;</td>


                  <td width="47%" valign="top" dir="rtl" style="background:#ffffff;border:1px solid #ede0f0;border-radius:12px;padding:20px 18px;text-align:right;">
                    <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#9b4aaa;text-transform:uppercase;letter-spacing:1.5px;">עברית</p>
                    <h2 style="margin:0 0 10px;font-size:17px;font-weight:800;color:#4b154c;line-height:1.3;">
                      הוזמנת אישית לדואולין
                    </h2>
                    <p style="margin:0;font-size:14px;font-weight:500;color:#3f3f46;line-height:1.75;">
                      <strong style="color:#4b154c;">${inviterName}</strong> חשבה שתתאימי לקהילה - רשת בלעדית ומהימנה לנשים חרדיות מקצועיות.
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          ${personalNoteBlock}

          <tr>
            <td style="padding:20px 40px 0;background:#fffcff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f9f2ff;border:1px solid #e8d4f5;border-radius:12px;padding:24px 24px;">

                    <p style="margin:0 0 18px;font-size:10px;font-weight:700;color:#9b4aaa;text-transform:uppercase;letter-spacing:2px;text-align:center;">
                      About duallin &nbsp;·&nbsp; אודות דואולין
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>

                        <td width="47%" valign="top" style="padding-right:16px;">
                          <p style="margin:0;font-size:13px;font-weight:600;color:#4a3550;line-height:1.9;">
                            Built exclusively for Haredi women in tech - real professional networking, a growing community that understands your world, meaningful career opportunities, daily job listings, and honest company insights from women who've actually been there. Not a chat group, not a mailing list - a permanent professional presence, built to last. The place where our community and the tech industry finally meet.
                          </p>
                        </td>


                        <td width="6%" style="text-align:center;vertical-align:middle;">
                          <div style="width:1px;background:linear-gradient(to bottom,transparent,#c9a0dc,transparent);height:100px;margin:0 auto;"></div>
                        </td>


                        <td width="47%" valign="top" dir="rtl" style="text-align:right;padding-left:16px;">
                          <p style="margin:0;font-size:13px;font-weight:600;color:#4a3550;line-height:1.9;">
                            נבנתה במיוחד לנשים חרדיות בהייטק - נטוורקינג מקצועי אמיתי, קהילה שמבינה את עולמך, הזדמנויות קריירה, משרות מדי יום, ומידע אמיתי על חברות מנשים שהיו שם. לא קבוצת צ׳אט ולא רשימת תפוצה - נוכחות מקצועית קבועה שבנויה להישאר. המקום שבו הקהילה שלנו ותעשיית ההייטק סוף סוף נפגשות.
                          </p>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>
            </td>
          </tr>


          <tr>
            <td style="padding:32px 40px 16px;background:#fffcff;text-align:center;">
              <a href="${inviteUrl}" style="display:inline-block;background:linear-gradient(135deg,#2d0838 0%,#762277 50%,#9b4aaa 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:17px 56px;border-radius:50px;letter-spacing:0.3px;box-shadow:0 6px 28px rgba(118,34,119,0.40);">
                Join duallin &nbsp;|&nbsp; הצטרפי לדואולין
              </a>
            </td>
          </tr>


          <tr>
            <td style="padding:12px 40px 36px;background:#fffcff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f5eaff;border:1px solid #ddb8ea;border-radius:10px;padding:13px 20px;text-align:center;">
                    <p style="margin:0;font-size:12px;font-weight:600;color:#6b2175;">
                    This invitation expires on <strong>${expiryDate}</strong>
                    </p><p style="margin:0;font-size:12px;font-weight:600;color:#6b2175;" dir="rtl">
                  ההזמנה תפוג בתאריך <strong>${expiryDate}</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>


          <tr>
            <td style="background:linear-gradient(135deg,#2d0838 0%,#4b154c 60%,#2d0838 100%);padding:28px 40px;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:500;color:rgba(255,255,255,0.55);">Questions? We're here for you.</p>
              <a href="mailto:contact@duallin.com" style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.90);text-decoration:none;">contact@duallin.com</a>
              <p style="margin:14px 0 0;font-size:11px;font-weight:500;color:rgba(255,255,255,0.30);">© 2026 duallin · All rights reserved</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'duallin <invites@duallin.com>',
      to: [to],
      subject: "You've been personally invited to duallin | הוזמנת אישית לדואולין",
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }
}
