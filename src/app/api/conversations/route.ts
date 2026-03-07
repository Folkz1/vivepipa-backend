import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const phone = searchParams.get("phone");

  // If phone provided, return conversation history
  if (phone) {
    const messages = await query<{
      id: string;
      role: string;
      content: string;
      created_at: string;
    }>(
      `SELECT id, role, content, created_at FROM messages
       WHERE phone = $1 ORDER BY created_at ASC`,
      [phone]
    );

    const conversation = await query<{
      phone_number: string;
      user_name: string;
      state: string;
      total_messages: number;
      lead_captured: boolean;
      last_interaction: string;
    }>(
      `SELECT phone_number, user_name, state, total_messages, lead_captured, last_interaction
       FROM conversations WHERE phone_number = $1`,
      [phone]
    );

    return Response.json({
      conversation: conversation[0] || null,
      messages,
    });
  }

  // List all conversations
  const conversations = await query<{
    phone_number: string;
    user_name: string;
    state: string;
    total_messages: number;
    lead_captured: boolean;
    last_interaction: string;
    last_message: string;
  }>(
    `SELECT c.phone_number, c.user_name, c.state, c.total_messages,
            c.lead_captured, c.last_interaction,
            (SELECT content FROM messages WHERE phone = c.phone_number ORDER BY created_at DESC LIMIT 1) as last_message
     FROM conversations c
     ORDER BY c.last_interaction DESC
     LIMIT 50`
  );

  return Response.json({ conversations });
}
