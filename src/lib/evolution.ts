const EVOLUTION_URL = process.env.EVOLUTION_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE!;

export async function sendMessage(phone: string, text: string) {
  const resp = await fetch(
    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: phone, text }),
    }
  );

  if (!resp.ok) {
    console.error("[EVOLUTION] Send failed:", resp.status, await resp.text());
  }

  return resp.ok;
}

export function extractTextFromMessage(messageData: Record<string, unknown>): string {
  if (typeof messageData.conversation === "string") return messageData.conversation;
  const ext = messageData.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string") return ext.text;
  return "";
}

export function extractPhoneFromJid(jid: string): string {
  return jid.replace("@s.whatsapp.net", "").replace("@c.us", "");
}
