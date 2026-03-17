import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import {
  sendMessage,
  sendAudioMessage,
  sendPresence,
  extractTextFromMessage,
  extractPhoneFromJid,
  getMediaType,
  getMediaMimetype,
  downloadMedia,
} from "@/lib/evolution";
import { getSystemPrompt } from "@/lib/system-prompt";

// OpenAI direct (Martin's key) for AI responses
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/** Web search via OpenAI Responses API (web_search_preview) */
async function webSearch(searchQuery: string): Promise<string> {
  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        tools: [{ type: "web_search_preview" }],
        input: `Pesquise e resuma em português de forma concisa: ${searchQuery}`,
      }),
    });
    if (!resp.ok) {
      console.error("[WEBSEARCH] Failed:", resp.status, await resp.text());
      return "Pesquisa indisponível no momento";
    }
    const data = await resp.json();
    // Responses API returns output array with message items
    const output = data.output || [];
    const textItems = output.filter((item: Record<string, unknown>) => item.type === "message");
    const result = textItems.map((item: Record<string, unknown>) => {
      const content = (item.content as Array<Record<string, unknown>>) || [];
      return content.filter((c) => c.type === "output_text").map((c) => c.text).join("");
    }).join("\n") || "Nenhum resultado encontrado";
    console.log(`[WEBSEARCH] Query: "${searchQuery}" -> ${result.substring(0, 100)}...`);
    return result;
  } catch (err) {
    console.error("[WEBSEARCH] Error:", err);
    return "Erro ao pesquisar na web";
  }
}

// OpenAI direct for Whisper (transcription) and TTS (audio response)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

async function getNotificationPhone(): Promise<string> {
  const config = await queryOne<{ notification_phone: string }>(
    `SELECT notification_phone FROM bot_config WHERE id = 1`
  );
  return config?.notification_phone || process.env.MARTIN_PHONE || "558481559502";
}

async function notifyOwner(text: string) {
  try {
    const phone = await getNotificationPhone();
    await sendMessage(phone, text);
    console.log(`[NOTIFY] Owner (${phone}) notified about new lead`);
  } catch (err) {
    console.error("[NOTIFY] Failed to notify owner:", err);
  }
}

/** Transcribe audio using OpenAI Whisper */
async function transcribeAudio(buffer: Uint8Array, mimetype: string): Promise<string> {
  try {
    const ext = mimetype.includes("ogg") ? "ogg" : mimetype.includes("mp4") ? "m4a" : "webm";
    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimetype });
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model", "whisper-1");
    formData.append("language", "pt");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    if (!resp.ok) {
      console.error("[WHISPER] Failed:", resp.status, await resp.text());
      return "";
    }

    const data = await resp.json();
    const text = data.text as string;
    console.log(`[WHISPER] Transcribed: ${text.substring(0, 100)}...`);
    return text;
  } catch (err) {
    console.error("[WHISPER] Error:", err);
    return "";
  }
}

/** Convert text to speech using OpenAI TTS */
async function textToSpeech(text: string): Promise<string | null> {
  try {
    // Truncate to ~4000 chars (TTS limit is 4096)
    const input = text.length > 4000 ? text.substring(0, 4000) + "..." : text;

    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "tts-1",
        input,
        voice: "nova", // Friendly female voice, good for tourism concierge
        response_format: "mp3",
      }),
    });

    if (!resp.ok) {
      console.error("[TTS] Failed:", resp.status, await resp.text());
      return null;
    }

    const audioBuffer = await resp.arrayBuffer();
    const base64 = Buffer.from(audioBuffer).toString("base64");
    console.log(`[TTS] Generated audio: ${(audioBuffer.byteLength / 1024).toFixed(1)}KB`);
    return `data:audio/mp3;base64,${base64}`;
  } catch (err) {
    console.error("[TTS] Error:", err);
    return null;
  }
}

/** Describe image using GPT-4o-mini vision */
async function describeImage(buffer: Uint8Array, mimetype: string, caption?: string): Promise<string> {
  try {
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUrl = `data:${mimetype};base64,${base64}`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: caption
                  ? `Descreva esta imagem em portugues de forma concisa. O usuario enviou com a legenda: "${caption}"`
                  : "Descreva esta imagem em portugues de forma concisa para contexto de uma conversa sobre turismo em Pipa/RN.",
              },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
        max_tokens: 300,
      }),
    });

    if (!resp.ok) {
      console.error("[VISION] Failed:", resp.status, await resp.text());
      return "";
    }

    const data = await resp.json();
    const desc = data.choices?.[0]?.message?.content || "";
    console.log(`[VISION] Described: ${desc.substring(0, 100)}...`);
    return desc;
  } catch (err) {
    console.error("[VISION] Error:", err);
    return "";
  }
}

export async function POST(req: Request) {
  try {
    const payload = await req.json();

    // Only process incoming messages
    if (payload.event !== "messages.upsert") {
      return Response.json({ ok: true });
    }

    const data = payload.data;
    const key = data.key;
    const remoteJid: string = key.remoteJid || "";
    const fromMe: boolean = key.fromMe || false;
    const pushName: string = data.pushName || "";
    const messageData = data.message || {};
    const messageId: string = key.id || "";

    // Skip own messages and groups
    if (fromMe) return Response.json({ ok: true });
    if (remoteJid.includes("@g.us")) return Response.json({ ok: true });
    if (!remoteJid) return Response.json({ ok: true });

    const phone = extractPhoneFromJid(remoteJid);

    // Extract text content
    let userText = extractTextFromMessage(messageData);

    // Track if input was audio (for audio response)
    let inputWasAudio = false;

    // Handle media messages (audio, image, video, document)
    const mediaType = getMediaType(messageData);
    if (mediaType && messageId) {
      const mimetype = getMediaMimetype(messageData) || "application/octet-stream";

      // Download media - tries webhook base64 first, then Evolution API
      const mediaBuffer = await downloadMedia(messageId, remoteJid, fromMe, data);

      if (mediaBuffer) {
        switch (mediaType) {
          case "audio": {
            inputWasAudio = true;
            const transcription = await transcribeAudio(mediaBuffer, mimetype);
            if (transcription) {
              userText = transcription;
            } else {
              userText = userText || "[Audio recebido mas nao foi possivel transcrever]";
            }
            break;
          }
          case "image": {
            const description = await describeImage(mediaBuffer, mimetype, userText || undefined);
            if (description) {
              userText = `[O usuario enviou uma imagem: ${description}]${userText ? `\nLegenda: ${userText}` : ""}`;
            } else {
              userText = userText || "[Imagem recebida]";
            }
            break;
          }
          case "video": {
            userText = userText || "[Video recebido - nao e possivel assistir, mas posso ajudar com o que voce precisa!]";
            if (userText && !userText.startsWith("[")) {
              userText = `[O usuario enviou um video com legenda]\nLegenda: ${userText}`;
            }
            break;
          }
          case "document": {
            const fileName = (messageData.documentMessage as Record<string, unknown>)?.fileName || "arquivo";
            userText = userText || `[Usuario enviou um documento: ${fileName}]`;
            break;
          }
        }
      } else if (!userText) {
        // Media couldn't be downloaded, provide context
        if (mediaType === "audio") {
          inputWasAudio = true;
          userText = "[Audio recebido mas nao disponivel para transcricao]";
        } else if (mediaType === "image") userText = "[Imagem recebida mas nao disponivel para analise]";
        else if (mediaType === "video") userText = "[Video recebido]";
        else userText = "[Documento recebido]";
      }
    }

    if (!userText.trim()) return Response.json({ ok: true });

    console.log(`[WEBHOOK] ${phone} (${pushName}): ${userText.substring(0, 200)}`);

    // Check if bot is active
    const config = await queryOne<{ active: boolean; system_prompt: string; model: string }>(
      `SELECT active, system_prompt, model FROM bot_config WHERE id = 1`
    );

    if (config && !config.active) {
      console.log("[WEBHOOK] Bot is inactive, skipping");
      return Response.json({ ok: true });
    }

    // Upsert conversation
    await query(
      `INSERT INTO conversations (phone_number, user_name, state, total_messages, last_interaction)
       VALUES ($1, $2, 'ACTIVE', 1, NOW())
       ON CONFLICT (phone_number) DO UPDATE SET
         user_name = COALESCE(EXCLUDED.user_name, conversations.user_name),
         total_messages = conversations.total_messages + 1,
         last_interaction = NOW(),
         updated_at = NOW()`,
      [phone, pushName || null]
    );

    // Save incoming message
    await query(
      `INSERT INTO messages (phone, role, content) VALUES ($1, $2, $3)`,
      [phone, "user", userText]
    );

    // Load conversation history (last 20 messages)
    const history = await query<{ role: string; content: string }>(
      `SELECT role, content FROM messages
       WHERE phone = $1 ORDER BY created_at DESC LIMIT 20`,
      [phone]
    );

    const messages = history.reverse().map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Get system prompt (custom or default)
    const systemPrompt = getSystemPrompt(config?.system_prompt);
    const modelId = config?.model || "gpt-4.1-mini";

    // Show typing indicator BEFORE AI generates response
    await sendPresence(phone, true);

    // Generate AI response with tools (OpenRouter + web search)
    const result = await generateText({
      model: openai(modelId),
      system: systemPrompt,
      messages,
      tools: {
        buscarKB: {
          description: "Busca informacoes na base de conhecimento de Pipa (restaurantes, praias, hospedagem, dicas, emergencias)",
          parameters: z.object({
            query: z.string().describe("Termo de busca"),
          }),
          execute: async ({ query: q }) => {
            const rows = await query(
              `SELECT title, content, subcategory, contact_info, address, google_maps_link, speciality
               FROM knowledge_base
               WHERE is_active = true AND (
                 title ILIKE $1 OR content ILIKE $1
                 OR subcategory ILIKE $1
                 OR $2 = ANY(keywords)
               ) ORDER BY priority LIMIT 5`,
              [`%${q}%`, q.toLowerCase()]
            );
            return rows.length > 0
              ? rows
              : [{ message: "Nenhuma informacao encontrada para: " + q }];
          },
        },
        buscarServicos: {
          description: "Busca passeios e transfers disponiveis com precos",
          parameters: z.object({
            categoria: z.enum(["passeios", "transfers"]).optional().describe("Filtrar por categoria"),
            query: z.string().optional().describe("Termo de busca"),
          }),
          execute: async ({ categoria, query: q }) => {
            let sql = `SELECT nome_servico, category, descricao_completa, roteiro, duracao,
                        valor_adulto, valor_crianca, o_que_inclui, ponto_de_encontro,
                        tipo_veiculo, capacidade_passageiros, trecho_principal, valor_trecho, observacoes
                 FROM servicos WHERE ativo = true`;
            const params: unknown[] = [];

            if (categoria) {
              params.push(categoria);
              sql += ` AND category = $${params.length}`;
            }
            if (q) {
              params.push(`%${q}%`);
              sql += ` AND (nome_servico ILIKE $${params.length} OR descricao_completa ILIKE $${params.length})`;
            }

            sql += " ORDER BY priority LIMIT 10";
            const rows = await query(sql, params);
            return rows.length > 0
              ? rows
              : [{ message: "Nenhum servico encontrado" }];
          },
        },
        registrarLead: {
          description: "Registra um lead quando o usuario forneceu nome, email e demonstrou interesse em servico. Use UMA VEZ por conversa.",
          parameters: z.object({
            nome: z.string().describe("Nome completo do usuario"),
            email: z.string().describe("Email do usuario"),
            interesse: z.string().describe("Servico de interesse (passeio, transfer, etc)"),
            detalhes: z.string().optional().describe("Detalhes adicionais (data, num pessoas, etc)"),
          }),
          execute: async ({ nome, email, interesse, detalhes }) => {
            // Check if lead already exists for this phone + service
            const existing = await queryOne<{ id: string }>(
              `SELECT id FROM leads WHERE phone_number = $1 AND service_category = $2`,
              [phone, interesse]
            );

            if (existing) {
              await query(
                `UPDATE leads SET
                  full_name = $1, email = $2, service_interest = $3,
                  qualification_data = $4, updated_at = NOW()
                 WHERE id = $5`,
                [
                  nome,
                  email,
                  detalhes || interesse,
                  JSON.stringify({ nome, email, interesse, detalhes, updated_at: new Date().toISOString() }),
                  existing.id,
                ]
              );
              console.log(`[LEAD] Updated existing lead ${existing.id} for ${phone}`);
              return { success: true, message: `Lead ${nome} atualizado com sucesso` };
            }

            const conv = await queryOne<{ id: string }>(
              `SELECT id FROM conversations WHERE phone_number = $1`,
              [phone]
            );

            await query(
              `INSERT INTO leads (conversation_id, phone_number, full_name, email, service_category, service_interest, qualification_data, status, priority)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', 1)`,
              [
                conv?.id || null,
                phone,
                nome,
                email,
                interesse,
                detalhes || interesse,
                JSON.stringify({ nome, email, interesse, detalhes, qualified_at: new Date().toISOString() }),
              ]
            );

            await query(
              `UPDATE conversations SET lead_captured = true, updated_at = NOW() WHERE phone_number = $1`,
              [phone]
            );

            await notifyOwner(
              `*Novo Lead Capturado!*\n\n` +
              `*Nome:* ${nome}\n` +
              `*Telefone:* ${phone}\n` +
              `*Email:* ${email}\n` +
              `*Interesse:* ${interesse}\n` +
              `*Detalhes:* ${detalhes || "-"}\n\n` +
              `_Capturado pela Sofia_`
            );

            console.log(`[LEAD] New lead created for ${phone}: ${nome} - ${interesse}`);
            return { success: true, message: `Lead ${nome} registrado com sucesso` };
          },
        },
        buscarWeb: {
          description: "Pesquisa na internet para informacoes atualizadas que nao estao na base local (eventos, clima, noticias, horarios atualizados, etc)",
          parameters: z.object({
            query: z.string().describe("O que pesquisar na web (em portugues)"),
          }),
          execute: async ({ query: q }) => {
            return await webSearch(q);
          },
        },
      },
      maxSteps: 5,
    });

    const aiResponse = result.text;

    if (aiResponse) {
      // Save AI response
      await query(
        `INSERT INTO messages (phone, role, content) VALUES ($1, $2, $3)`,
        [phone, "assistant", aiResponse]
      );

      // If user sent audio, respond with audio (TTS) + text fallback
      if (inputWasAudio) {
        const audioBase64 = await textToSpeech(aiResponse);
        if (audioBase64) {
          await sendAudioMessage(phone, audioBase64);
          console.log(`[WEBHOOK] Audio response sent to ${phone}`);
        } else {
          // TTS failed, fall back to text
          await sendMessage(phone, aiResponse);
          console.log(`[WEBHOOK] TTS failed, text fallback to ${phone}`);
        }
      } else {
        // Regular text response
        await sendMessage(phone, aiResponse);
        console.log(`[WEBHOOK] Responded to ${phone}: ${aiResponse.substring(0, 100)}...`);
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    const errMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[WEBHOOK] Error:", errMsg, error instanceof Error ? error.stack : "");
    return Response.json({ error: errMsg }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ status: "Vive Pipa webhook active", version: "2.1", features: ["openrouter", "websearch", "tts", "base64-media"] });
}
