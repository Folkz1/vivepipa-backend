import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  let sql = `SELECT id, phone_number, full_name, email, service_category,
                    service_interest, qualification_data, status, priority,
                    notes, assigned_to, created_at
             FROM leads`;
  const params: unknown[] = [];

  if (status) {
    params.push(status);
    sql += ` WHERE status = $1`;
  }

  sql += ` ORDER BY created_at DESC LIMIT 100`;

  const leads = await query(sql, params);
  return Response.json({ leads });
}

export async function PUT(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { id, status, notes, assigned_to } = body;

  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  await query(
    `UPDATE leads SET
       status = COALESCE($2, status),
       notes = COALESCE($3, notes),
       assigned_to = COALESCE($4, assigned_to),
       updated_at = NOW()
     WHERE id = $1`,
    [id, status ?? null, notes ?? null, assigned_to ?? null]
  );

  return Response.json({ ok: true });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
