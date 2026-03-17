import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";
import { getSystemPrompt } from "@/lib/system-prompt";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const TEST_PHONE = "test_dashboard";

async function generateWithOpenRouter(
  systemPrompt: string,
  chatMessages: Array<{ role: string; content: string }>,
): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4.1-mini",
      messages: [{ role: "system", content: systemPrompt }, ...chatMessages],
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${errBody.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

/** Test bot endpoint — same AI logic as webhook but no WhatsApp sending */
export async function POST(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const userMessage = (body.message as string)?.trim();

    if (!userMessage) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const config = await queryOne<{ system_prompt: string; model: string }>(
      `SELECT system_prompt, model FROM bot_config WHERE id = 1`
    );

    // Upsert test conversation
    await query(
      `INSERT INTO conversations (phone_number, user_name, state, total_messages, last_interaction)
       VALUES ($1, 'Teste Dashboard', 'ACTIVE', 1, NOW())
       ON CONFLICT (phone_number) DO UPDATE SET
         total_messages = conversations.total_messages + 1,
         last_interaction = NOW(),
         updated_at = NOW()`,
      [TEST_PHONE]
    );

    // Save user message
    await query(
      `INSERT INTO messages (phone, role, content) VALUES ($1, $2, $3)`,
      [TEST_PHONE, "user", userMessage]
    );

    // Load history (last 20)
    const history = await query<{ role: string; content: string }>(
      `SELECT role, content FROM messages WHERE phone = $1 ORDER BY created_at DESC LIMIT 20`,
      [TEST_PHONE]
    );
    const messages = history.reverse().map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const systemPrompt = getSystemPrompt(config?.system_prompt);
    const modelId = config?.model || "gpt-4.1-mini";

    const tools = {
      buscarKB: {
        description: "Busca informacoes na base de conhecimento de Pipa",
        parameters: z.object({ query: z.string().describe("Termo de busca") }),
        execute: async ({ query: q }: { query: string }) => {
          const rows = await query(
            `SELECT title, content, subcategory, contact_info, address, speciality
             FROM knowledge_base
             WHERE is_active = true AND (title ILIKE $1 OR content ILIKE $1 OR $2 = ANY(keywords))
             ORDER BY priority LIMIT 5`,
            [`%${q}%`, q.toLowerCase()]
          );
          return rows.length > 0 ? rows : [{ message: "Nenhuma informacao para: " + q }];
        },
      },
      buscarServicos: {
        description: "Busca passeios e transfers disponiveis com precos",
        parameters: z.object({
          categoria: z.enum(["passeios", "transfers"]).optional(),
          query: z.string().optional(),
        }),
        execute: async ({ categoria, query: q }: { categoria?: string; query?: string }) => {
          let sql = `SELECT nome_servico, category, descricao_completa, valor_adulto, valor_trecho, trecho_principal
                     FROM servicos WHERE ativo = true`;
          const params: unknown[] = [];
          if (categoria) { params.push(categoria); sql += ` AND category = $${params.length}`; }
          if (q) { params.push(`%${q}%`); sql += ` AND nome_servico ILIKE $${params.length}`; }
          sql += " ORDER BY priority LIMIT 10";
          const rows = await query(sql, params);
          return rows.length > 0 ? rows : [{ message: "Nenhum servico encontrado" }];
        },
      },
      registrarLead: {
        description: "Registra lead (simulado no modo teste — nao salva nem notifica)",
        parameters: z.object({
          nome: z.string(),
          email: z.string(),
          interesse: z.string(),
          detalhes: z.string().optional(),
        }),
        execute: async ({ nome, email, interesse }: { nome: string; email: string; interesse: string; detalhes?: string }) => {
          console.log(`[TEST] Lead simulado: ${nome} / ${email} / ${interesse}`);
          return { success: true, message: `[TESTE] Lead ${nome} seria registrado (nao salvo em producao)` };
        },
      },
    };

    let responseText = "";
    try {
      const result = await generateText({
        model: openai(modelId),
        system: systemPrompt,
        messages,
        tools,
        maxSteps: 5,
      });
      responseText = result.text;
    } catch (err) {
      console.log("[TEST] OpenAI failed, trying OpenRouter:", err instanceof Error ? err.message : String(err));
      responseText = await generateWithOpenRouter(systemPrompt, messages);
    }

    if (responseText) {
      await query(
        `INSERT INTO messages (phone, role, content) VALUES ($1, $2, $3)`,
        [TEST_PHONE, "assistant", responseText]
      );
    }

    return Response.json({ response: responseText });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[TEST] Error:", errMsg);
    return Response.json({ error: errMsg }, { status: 500 });
  }
}

/** Clear test conversation history */
export async function DELETE(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await query(`DELETE FROM messages WHERE phone = $1`, [TEST_PHONE]);
  await query(`DELETE FROM conversations WHERE phone_number = $1`, [TEST_PHONE]);
  return Response.json({ ok: true });
}
