import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import { sendMessage, extractTextFromMessage, extractPhoneFromJid } from "@/lib/evolution";
import { getSystemPrompt } from "@/lib/system-prompt";

const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
});

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

    // Skip own messages and groups
    if (fromMe) return Response.json({ ok: true });
    if (remoteJid.includes("@g.us")) return Response.json({ ok: true });
    if (!remoteJid) return Response.json({ ok: true });

    const phone = extractPhoneFromJid(remoteJid);
    const userText = extractTextFromMessage(messageData);

    if (!userText.trim()) return Response.json({ ok: true });

    console.log(`[WEBHOOK] ${phone} (${pushName}): ${userText}`);

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
    const modelId = config?.model || "anthropic/claude-sonnet-4";

    // Generate AI response with tools
    const result = await generateText({
      model: openrouter(modelId),
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
        qualificarLead: {
          description: "Registra um lead qualificado quando o usuario demonstrou interesse e forneceu dados de contato",
          parameters: z.object({
            nome: z.string().describe("Nome completo do usuario"),
            email: z.string().describe("Email do usuario"),
            interesse: z.string().describe("Servico de interesse (passeio, transfer, etc)"),
            detalhes: z.string().optional().describe("Detalhes adicionais (data, num pessoas, etc)"),
          }),
          execute: async ({ nome, email, interesse, detalhes }) => {
            // Get or create conversation
            const conv = await queryOne<{ id: string }>(
              `SELECT id FROM conversations WHERE phone_number = $1`,
              [phone]
            );

            await query(
              `INSERT INTO leads (conversation_id, phone_number, full_name, email, service_category, service_interest, qualification_data, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')`,
              [
                conv?.id || null,
                phone,
                nome,
                email,
                interesse,
                detalhes || null,
                JSON.stringify({ nome, email, interesse, detalhes, qualified_at: new Date().toISOString() }),
              ]
            );

            // Update conversation
            await query(
              `UPDATE conversations SET lead_captured = true, updated_at = NOW() WHERE phone_number = $1`,
              [phone]
            );

            return { success: true, message: `Lead ${nome} registrado com sucesso` };
          },
        },
        salvarLead: {
          description: "Salva lead completo e marca para acompanhamento pelo especialista humano",
          parameters: z.object({
            nome: z.string(),
            email: z.string(),
            servico: z.string(),
            data_viagem: z.string().optional(),
            num_pessoas: z.number().optional(),
            observacoes: z.string().optional(),
          }),
          execute: async ({ nome, email, servico, data_viagem, num_pessoas, observacoes }) => {
            const conv = await queryOne<{ id: string }>(
              `SELECT id FROM conversations WHERE phone_number = $1`,
              [phone]
            );

            await query(
              `INSERT INTO leads (conversation_id, phone_number, full_name, email, service_category, service_interest, qualification_data, status, priority)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'qualified', 1)
               ON CONFLICT DO NOTHING`,
              [
                conv?.id || null,
                phone,
                nome,
                email,
                servico,
                `${servico} - ${data_viagem || "sem data"} - ${num_pessoas || "?"} pessoas`,
                JSON.stringify({ nome, email, servico, data_viagem, num_pessoas, observacoes, saved_at: new Date().toISOString() }),
              ]
            );

            await query(
              `UPDATE conversations SET lead_captured = true, state = 'QUALIFIED', updated_at = NOW() WHERE phone_number = $1`,
              [phone]
            );

            return { success: true, message: "Lead salvo. Especialista sera notificado." };
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

      // Send via Evolution
      await sendMessage(phone, aiResponse);
      console.log(`[WEBHOOK] Responded to ${phone}: ${aiResponse.substring(0, 100)}...`);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("[WEBHOOK] Error:", error);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ status: "Vive Pipa webhook active" });
}
