import { NextRequest } from "next/server";
import { query, queryOne } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";

const CATEGORIES = [
  "idioma_errado",
  "info_inventada",
  "formal_demais",
  "fora_tema",
  "incompleta",
  "repetitiva",
  "outro",
] as const;

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

/** Save feedback for a bot message */
export async function POST(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { message_id, rating, category, expected_response, comment } = body;

    if (!message_id || !rating) {
      return Response.json(
        { error: "message_id and rating are required" },
        { status: 400 },
      );
    }

    if (!["good", "bad"].includes(rating)) {
      return Response.json(
        { error: "rating must be 'good' or 'bad'" },
        { status: 400 },
      );
    }

    // Verify message exists
    const msg = await queryOne(
      `SELECT id FROM messages WHERE id = $1`,
      [message_id],
    );
    if (!msg) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    // Upsert feedback (one per message)
    const result = await query(
      `INSERT INTO message_feedback (message_id, rating, category, expected_response, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         category = EXCLUDED.category,
         expected_response = EXCLUDED.expected_response,
         comment = EXCLUDED.comment,
         created_at = NOW()
       RETURNING id`,
      [message_id, rating, category || null, expected_response || null, comment || null],
    );

    return Response.json({ ok: true, id: result[0]?.id });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[FEEDBACK] Error:", errMsg);
    return Response.json({ error: errMsg }, { status: 500 });
  }
}

/** List feedbacks with optional summary */
export async function GET(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const summary = searchParams.get("summary") === "true";

  try {
    if (summary) {
      // Aggregated stats for Diego
      const stats = await query<{
        total: string;
        good: string;
        bad: string;
      }>(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE rating = 'good') as good,
           COUNT(*) FILTER (WHERE rating = 'bad') as bad
         FROM message_feedback`,
      );

      const categories = await query<{ category: string; count: string }>(
        `SELECT category, COUNT(*) as count
         FROM message_feedback
         WHERE rating = 'bad' AND category IS NOT NULL
         GROUP BY category
         ORDER BY count DESC`,
      );

      const recent_bad = await query<{
        id: string;
        category: string;
        expected_response: string;
        comment: string;
        original_content: string;
        user_message: string;
        created_at: string;
      }>(
        `SELECT
           f.id, f.category, f.expected_response, f.comment, f.created_at,
           m.content as original_content,
           (SELECT m2.content FROM messages m2
            WHERE m2.phone = m.phone AND m2.role = 'user' AND m2.created_at < m.created_at
            ORDER BY m2.created_at DESC LIMIT 1) as user_message
         FROM message_feedback f
         JOIN messages m ON m.id = f.message_id
         WHERE f.rating = 'bad'
         ORDER BY f.created_at DESC
         LIMIT 20`,
      );

      return Response.json({
        stats: stats[0],
        categories,
        recent_bad,
      });
    }

    // Full list
    const feedbacks = await query(
      `SELECT
         f.*,
         m.content as bot_response,
         m.created_at as message_at,
         (SELECT m2.content FROM messages m2
          WHERE m2.phone = m.phone AND m2.role = 'user' AND m2.created_at < m.created_at
          ORDER BY m2.created_at DESC LIMIT 1) as user_input
       FROM message_feedback f
       JOIN messages m ON m.id = f.message_id
       ORDER BY f.created_at DESC
       LIMIT 100`,
    );

    return Response.json({ feedbacks, categories: CATEGORIES });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[FEEDBACK] Error:", errMsg);
    return Response.json({ error: errMsg }, { status: 500 });
  }
}
