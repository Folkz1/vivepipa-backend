import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { sendMessage } from "@/lib/evolution";

const CRON_SECRET = process.env.CRON_SECRET || process.env.API_SECRET;

const FOLLOWUP_MESSAGES: Record<string, [string, string]> = {
  pt: [
    "Ficou alguma dúvida sobre a cotação? Estou à disposição.",
    "Caso queira confirmar o transfer, é só me avisar. Estou aqui.",
  ],
  es: [
    "Quedó alguna duda sobre la cotización? Estoy a disposición.",
    "Si querés confirmar el transfer, avisame. Estoy acá.",
  ],
  en: [
    "Any questions about the quote? I'm here to help.",
    "Whenever you're ready to confirm the transfer, just let me know.",
  ],
};

/** GET /api/cron/followup — called by Vercel Cron every 5 minutes */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "");
  if (CRON_SECRET && auth !== CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Find conversations that received a quote and have not responded yet
  // followup_count < 2: max 2 follow-ups
  // last_quote_at: when quote was sent
  // last_interaction: when user last messaged (if after last_quote_at → user responded, skip)
  const candidates = await query<{
    phone_number: string;
    language: string;
    followup_count: number;
    last_quote_at: Date;
    last_interaction: Date;
  }>(`
    SELECT phone_number, language, followup_count, last_quote_at, last_interaction
    FROM conversations
    WHERE state = 'QUOTED'
      AND followup_count < 2
      AND last_quote_at IS NOT NULL
  `);

  let sent = 0;
  let skipped = 0;

  for (const conv of candidates) {
    const quoteAge = now.getTime() - new Date(conv.last_quote_at).getTime();
    const lastInteractionAfterQuote =
      new Date(conv.last_interaction) > new Date(conv.last_quote_at);

    // If user replied after the quote was sent, reset and skip
    if (lastInteractionAfterQuote) {
      await query(
        `UPDATE conversations SET state = 'ACTIVE', followup_count = 0, last_quote_at = NULL WHERE phone_number = $1`,
        [conv.phone_number]
      );
      skipped++;
      continue;
    }

    const thirtyMin = 30 * 60 * 1000;
    const twentyFourH = 24 * 60 * 60 * 1000;

    // followup_count=0: send after 30min; followup_count=1: send after 24h
    const threshold = conv.followup_count === 0 ? thirtyMin : twentyFourH;
    if (quoteAge < threshold) {
      skipped++;
      continue;
    }

    const lang = (conv.language || "pt").substring(0, 2);
    const messages = FOLLOWUP_MESSAGES[lang] || FOLLOWUP_MESSAGES.pt;
    const text = messages[conv.followup_count] || messages[0];

    try {
      await sendMessage(conv.phone_number, text);
      const newCount = conv.followup_count + 1;
      const newState = newCount >= 2 ? "CLOSED" : "QUOTED";
      await query(
        `UPDATE conversations SET followup_count = $1, state = $2 WHERE phone_number = $3`,
        [newCount, newState, conv.phone_number]
      );
      sent++;
      console.log(
        `[FOLLOWUP] ${conv.phone_number} followup #${newCount} sent (${lang})`
      );
    } catch (err) {
      console.error(`[FOLLOWUP] Failed to send to ${conv.phone_number}:`, err);
    }
  }

  return Response.json({ ok: true, sent, skipped, total: candidates.length });
}
