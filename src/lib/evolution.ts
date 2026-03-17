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

/** Send audio as WhatsApp voice note via Evolution API */
export async function sendAudioMessage(phone: string, audioBase64: string): Promise<boolean> {
  try {
    await sendPresence(phone, true);
    await new Promise((r) => setTimeout(r, 800));

    const resp = await fetch(
      `${EVOLUTION_URL}/message/sendWhatsAppAudio/${EVOLUTION_INSTANCE}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          number: phone,
          audio: audioBase64,
        }),
      }
    );

    await sendPresence(phone, false);

    if (!resp.ok) {
      console.error("[EVOLUTION] Audio send failed:", resp.status, await resp.text());
      return false;
    }
    console.log(`[EVOLUTION] Audio sent to ${phone}`);
    return true;
  } catch (err) {
    console.error("[EVOLUTION] Audio send error:", err);
    return false;
  }
}

/**
 * Extract base64 media from webhook payload (when webhookBase64 is enabled).
 * Returns { base64, mimetype } or null.
 */
export function extractMediaBase64FromPayload(
  data: Record<string, unknown>
): { base64: string; mimetype: string } | null {
  const message = data.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const mediaTypes = [
    "audioMessage",
    "imageMessage",
    "documentMessage",
    "videoMessage",
  ];

  for (const type of mediaTypes) {
    const mediaMsg = message[type] as Record<string, unknown> | undefined;
    if (mediaMsg?.base64) {
      let b64 = mediaMsg.base64 as string;
      if (b64.includes(",")) b64 = b64.split(",")[1];
      const mimetype = (mediaMsg.mimetype as string) || "application/octet-stream";
      return { base64: b64, mimetype };
    }
  }

  // Some Evolution versions put base64 at data level
  if (typeof data.base64 === "string") {
    let b64 = data.base64 as string;
    if (b64.includes(",")) b64 = b64.split(",")[1];
    // Try to find mimetype from the message
    for (const type of mediaTypes) {
      const mediaMsg = message?.[type] as Record<string, unknown> | undefined;
      if (mediaMsg?.mimetype) {
        return { base64: b64, mimetype: mediaMsg.mimetype as string };
      }
    }
    return { base64: b64, mimetype: "application/octet-stream" };
  }

  return null;
}

/**
 * Download media from Evolution API v2.
 * Strategy:
 * 1. Try base64 from webhook payload (webhookBase64 enabled)
 * 2. POST /chat/getBase64FromMediaMessage/{instance} (v2 endpoint)
 * 3. GET /message/getBase64/{instance}/{id} (v1 fallback)
 */
export async function downloadMedia(
  messageId: string,
  remoteJid: string,
  fromMe: boolean,
  payloadData?: Record<string, unknown>,
): Promise<Uint8Array | null> {
  // Strategy 1: base64 from webhook payload (fastest, no extra API call)
  if (payloadData) {
    const inline = extractMediaBase64FromPayload(payloadData);
    if (inline) {
      console.log(`[EVOLUTION] Media from webhook payload base64 for ${messageId}`);
      return new Uint8Array(Buffer.from(inline.base64, "base64"));
    }
  }

  const headers = { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" };

  // Strategy 2: v2 endpoint
  try {
    const v2Url = `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`;
    const resp = await fetch(v2Url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: {
          key: { id: messageId, remoteJid, fromMe },
        },
        convertToMp4: false,
      }),
    });

    if (resp.ok) {
      const respData = await resp.json();
      let b64 = typeof respData === "string" ? respData : respData.base64 || "";
      if (b64) {
        if (b64.includes(",")) b64 = b64.split(",")[1];
        console.log(`[EVOLUTION] Media downloaded via v2 for ${messageId}`);
        return new Uint8Array(Buffer.from(b64, "base64"));
      }
    }
  } catch (err) {
    console.error("[EVOLUTION] v2 getBase64 failed, trying v1:", err);
  }

  // Strategy 3: v1 fallback
  try {
    const v1Url = `${EVOLUTION_URL}/message/getBase64/${EVOLUTION_INSTANCE}/${messageId}`;
    const resp = await fetch(v1Url, { headers: { apikey: EVOLUTION_API_KEY } });

    if (resp.ok) {
      const respData = await resp.json();
      let b64 = typeof respData === "string" ? respData : respData.base64 || "";
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

  // Image/video/document caption
  const imageMsg = messageData.imageMessage as Record<string, unknown> | undefined;
  if (imageMsg && typeof imageMsg.caption === "string") return imageMsg.caption;
  const videoMsg = messageData.videoMessage as Record<string, unknown> | undefined;
  if (videoMsg && typeof videoMsg.caption === "string") return videoMsg.caption;
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
export function getMediaType(messageData: Record<string, unknown>): "audio" | "image" | "video" | "document" | null {
  if (messageData.audioMessage) return "audio";
  if (messageData.imageMessage) return "image";
  if (messageData.videoMessage) return "video";
  if (messageData.documentMessage) return "document";
  if (messageData.documentWithCaptionMessage) return "document";
  return null;
}

/** Get mimetype from media message */
export function getMediaMimetype(messageData: Record<string, unknown>): string | null {
  const types = ["audioMessage", "imageMessage", "videoMessage", "documentMessage"] as const;
  for (const t of types) {
    const msg = messageData[t] as Record<string, unknown> | undefined;
    if (msg?.mimetype) return msg.mimetype as string;
  }
  return null;
}

export function extractPhoneFromJid(jid: string): string {
  return jid.replace("@s.whatsapp.net", "").replace("@c.us", "");
}
