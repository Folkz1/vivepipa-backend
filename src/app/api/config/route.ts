import { NextRequest } from "next/server";
import { query, queryOne } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = await queryOne<{
    system_prompt: string;
    active: boolean;
    model: string;
    notification_phone: string;
    updated_at: string;
  }>(`SELECT system_prompt, active, model, notification_phone, updated_at FROM bot_config WHERE id = 1`);

  if (!config) {
    return Response.json({
      system_prompt: "",
      active: true,
      model: "gpt-4.1-mini",
      notification_phone: "",
      updated_at: null,
    });
  }

  return Response.json(config);
}

export async function PUT(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { system_prompt, active, model, notification_phone } = body;

  await query(
    `INSERT INTO bot_config (id, system_prompt, active, model, notification_phone, updated_at)
     VALUES (1, $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       system_prompt = COALESCE($1, bot_config.system_prompt),
       active = COALESCE($2, bot_config.active),
       model = COALESCE($3, bot_config.model),
       notification_phone = COALESCE($4, bot_config.notification_phone),
       updated_at = NOW()`,
    [system_prompt ?? null, active ?? null, model ?? null, notification_phone ?? null]
  );

  return Response.json({ ok: true });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
