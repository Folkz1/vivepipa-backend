const EVOLUTION_URL = process.env.EVOLUTION_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE!;

/** Send typing indicator (composing) */
async function sendPresence(phone: string, composing: boolean) {
  try {
    await fetch(
      `${EVOLUTION_URL}/chat/presence/${EVOLUTION_INSTANCE}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          number: phone,
          presence: composing ? "composing" : "paused",
        }),
      }
    );
  } catch (err) {
    console.error("[EVOLUTION] Presence failed:", err);
  }
}

/** Split text into WhatsApp-friendly blocks (max ~500 chars per block) */
function splitMessage(text: string): string[] {
  if (text.length <= 600) return [text];

  const blocks: string[] = [];
  const paragraphs = text.split(/\n\n+/);

  let current = "";
  for (const p of paragraphs) {
    if (current && (current.length + p.length + 2) > 500) {
      blocks.push(current.trim());
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current.trim()) blocks.push(current.trim());

  // If we ended up with just 1 block (no double newlines), split by single newline
  if (blocks.length === 1 && blocks[0].length > 600) {
    const lines = blocks[0].split("\n");
    blocks.length = 0;
    current = "";
    for (const line of lines) {
      if (current && (current.length + line.length + 1) > 500) {
        blocks.push(current.trim());
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current.trim()) blocks.push(current.trim());
  }

  // Cap at 4 blocks max
  if (blocks.length > 4) {
    const merged = blocks.slice(3).join("\n\n");
    blocks.length = 3;
    blocks.push(merged);
  }

  return blocks;
}

/** Send message with typing indicator and smart splitting */
export async function sendMessage(phone: string, text: string) {
  const blocks = splitMessage(text);

  for (let i = 0; i < blocks.length; i++) {
    // Show typing before each block
    await sendPresence(phone, true);

    // Simulate typing delay (proportional to message length, max 3s)
    const delay = Math.min(Math.max(blocks[i].length * 40, 800), 3000);
    await new Promise((r) => setTimeout(r, delay));

    const resp = await fetch(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({ number: phone, text: blocks[i] }),
      }
    );

    if (!resp.ok) {
      console.error("[EVOLUTION] Send failed:", resp.status, await resp.text());
      return false;
    }

    // Small gap between blocks
    if (i < blocks.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Stop typing
  await sendPresence(phone, false);
  return true;
}

/**
 * Download media from Evolution API v2.
 * Strategy (same as Orquestra):
 * 1. POST /chat/getBase64FromMediaMessage/{instance} (v2 endpoint)
 * 2. GET /message/getBase64/{instance}/{id} (v1 fallback)
 */
export async function downloadMedia(
  messageId: string,
  remoteJid: string,
  fromMe: boolean,
): Promise<Uint8Array | null> {
  const headers = { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" };

  // v2 endpoint: POST /chat/getBase64FromMediaMessage/{instance}
  try {
    const v2Url = `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`;
    const resp = await fetch(v2Url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: {
          key: {
            id: messageId,
            remoteJid,
            fromMe,
          },
        },
        convertToMp4: false,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      let b64 = typeof data === "string" ? data : data.base64 || "";
      if (b64) {
        if (b64.includes(",")) b64 = b64.split(",")[1];
        console.log(`[EVOLUTION] Media downloaded via v2 for ${messageId}`);
        return new Uint8Array(Buffer.from(b64, "base64"));
      }
    }
  } catch (err) {
    console.error("[EVOLUTION] v2 getBase64 failed, trying v1:", err);
  }

  // v1 fallback: GET /message/getBase64/{instance}/{id}
  try {
    const v1Url = `${EVOLUTION_URL}/message/getBase64/${EVOLUTION_INSTANCE}/${messageId}`;
    const resp = await fetch(v1Url, { headers: { apikey: EVOLUTION_API_KEY } });

    if (resp.ok) {
      const data = await resp.json();
      let b64 = typeof data === "string" ? data : data.base64 || "";
      if (b64) {
        if (b64.includes(",")) b64 = b64.split(",")[1];
        console.log(`[EVOLUTION] Media downloaded via v1 for ${messageId}`);
        return new Uint8Array(Buffer.from(b64, "base64"));
      }
    }
  } catch (err) {
    console.error("[EVOLUTION] v1 getBase64 also failed:", err);
  }

  return null;
}

/** Extract text from any message type */
export function extractTextFromMessage(messageData: Record<string, unknown>): string {
  // Regular text
  if (typeof messageData.conversation === "string") return messageData.conversation;
  const ext = messageData.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string") return ext.text;

  // Image/document caption
  const imageMsg = messageData.imageMessage as Record<string, unknown> | undefined;
  if (imageMsg && typeof imageMsg.caption === "string") return imageMsg.caption;
  const documentMsg = messageData.documentMessage as Record<string, unknown> | undefined;
  if (documentMsg && typeof documentMsg.caption === "string") return documentMsg.caption;
  // documentWithCaption
  const docWithCaption = messageData.documentWithCaptionMessage as Record<string, unknown> | undefined;
  if (docWithCaption) {
    const inner = (docWithCaption as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (inner) {
      const innerDoc = inner.documentMessage as Record<string, unknown> | undefined;
      if (innerDoc && typeof innerDoc.caption === "string") return innerDoc.caption;
    }
  }

  return "";
}

/** Get media type from message */
export function getMediaType(messageData: Record<string, unknown>): "audio" | "image" | "document" | null {
  if (messageData.audioMessage) return "audio";
  if (messageData.imageMessage) return "image";
  if (messageData.documentMessage) return "document";
  if (messageData.documentWithCaptionMessage) return "document";
  return null;
}

/** Get mimetype from media message */
export function getMediaMimetype(messageData: Record<string, unknown>): string | null {
  const types = ["audioMessage", "imageMessage", "documentMessage"] as const;
  for (const t of types) {
    const msg = messageData[t] as Record<string, unknown> | undefined;
    if (msg?.mimetype) return msg.mimetype as string;
  }
  return null;
}

export function extractPhoneFromJid(jid: string): string {
  return jid.replace("@s.whatsapp.net", "").replace("@c.us", "");
}
