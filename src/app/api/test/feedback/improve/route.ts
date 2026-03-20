import { NextRequest } from "next/server";
import { query, queryOne } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";
import { createHash } from "crypto";

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

/**
 * Analyze bad feedbacks and generate prompt improvement suggestions.
 * Uses OpenRouter to analyze patterns and suggest system prompt changes.
 */
export async function POST(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get current system prompt
    const config = await queryOne<{ system_prompt: string }>(
      `SELECT system_prompt FROM bot_config WHERE id = 1`,
    );
    const currentPrompt = config?.system_prompt || "(default)";

    // Get all bad feedbacks with context
    const badFeedbacks = await query<{
      category: string;
      expected_response: string;
      comment: string;
      original_content: string;
      user_message: string;
    }>(
      `SELECT
         f.category, f.expected_response, f.comment,
         m.content as original_content,
         (SELECT m2.content FROM messages m2
          WHERE m2.phone = m.phone AND m2.role = 'user' AND m2.created_at < m.created_at
          ORDER BY m2.created_at DESC LIMIT 1) as user_message
       FROM message_feedback f
       JOIN messages m ON m.id = f.message_id
       WHERE f.rating = 'bad'
       ORDER BY f.created_at DESC
       LIMIT 50`,
    );

    if (badFeedbacks.length === 0) {
      return Response.json({
        message: "Nenhum feedback negativo encontrado. O bot parece estar indo bem!",
        suggestions: [],
      });
    }

    // Build analysis prompt
    const feedbackList = badFeedbacks
      .map((f, i) => {
        let entry = `${i + 1}. [${f.category || "sem categoria"}]`;
        if (f.user_message) entry += `\n   Usuário disse: "${f.user_message}"`;
        entry += `\n   Bot respondeu: "${f.original_content?.substring(0, 200)}"`;
        if (f.expected_response)
          entry += `\n   Esperado: "${f.expected_response}"`;
        if (f.comment) entry += `\n   Comentário: "${f.comment}"`;
        return entry;
      })
      .join("\n\n");

    const analysisPrompt = `Você é um especialista em otimização de prompts de chatbot.

Analise os feedbacks negativos abaixo e gere SUGESTÕES ESPECÍFICAS para melhorar o system prompt.

## System Prompt Atual
${currentPrompt}

## Feedbacks Negativos (${badFeedbacks.length} total)
${feedbackList}

## Sua tarefa
1. Identifique PADRÕES nos feedbacks (ex: 70% são sobre idioma)
2. Para cada padrão, sugira uma MUDANÇA ESPECÍFICA no system prompt
3. Escreva as mudanças como trechos que podem ser adicionados/substituídos no prompt
4. Priorize por frequência (problema mais comum primeiro)

Responda em JSON:
{
  "patterns": [{"issue": "...", "frequency": "X de Y feedbacks", "severity": "alta|media|baixa"}],
  "suggestions": [{"description": "...", "prompt_addition": "...", "replaces": "trecho a substituir ou null se for adição"}],
  "summary": "resumo executivo em 2 linhas"
}`;

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4.1-mini",
        messages: [{ role: "user", content: analysisPrompt }],
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`OpenRouter ${resp.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await resp.json();
    const analysis = JSON.parse(
      data.choices?.[0]?.message?.content || "{}",
    );

    // Save improvement suggestion
    const promptHash = createHash("md5")
      .update(currentPrompt)
      .digest("hex");
    const categories = [
      ...new Set(badFeedbacks.map((f) => f.category).filter(Boolean)),
    ];

    await query(
      `INSERT INTO prompt_improvements (current_prompt_hash, suggested_changes, based_on_count, categories_addressed)
       VALUES ($1, $2, $3, $4)`,
      [
        promptHash,
        JSON.stringify(analysis),
        badFeedbacks.length,
        categories,
      ],
    );

    return Response.json({
      feedback_count: badFeedbacks.length,
      analysis,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[IMPROVE] Error:", errMsg);
    return Response.json({ error: errMsg }, { status: 500 });
  }
}
