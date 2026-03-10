import { NextRequest } from "next/server";
import { query, queryOne } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const category = req.nextUrl.searchParams.get("category");
  const includeInactive = req.nextUrl.searchParams.get("all") === "true";

  let sql = `SELECT id, nome_servico, category, ativo, descricao_completa, roteiro, duracao,
    valor_adulto, valor_crianca, o_que_inclui, ponto_de_encontro,
    tipo_veiculo, capacidade_passageiros, trecho_principal, valor_trecho,
    observacoes, keywords, priority, created_at, updated_at
    FROM servicos`;

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (!includeInactive) {
    conditions.push("ativo = true");
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  sql += " ORDER BY category, priority, nome_servico";

  const servicos = await query(sql, params);
  return Response.json({ servicos });
}

export async function POST(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    nome_servico, category, descricao_completa, roteiro, duracao,
    valor_adulto, valor_crianca, o_que_inclui, ponto_de_encontro,
    tipo_veiculo, capacidade_passageiros, trecho_principal, valor_trecho,
    observacoes, keywords, priority, ativo,
  } = body;

  if (!nome_servico || !category) {
    return Response.json({ error: "nome_servico and category are required" }, { status: 400 });
  }

  const result = await query(
    `INSERT INTO servicos (nome_servico, category, descricao_completa, roteiro, duracao,
      valor_adulto, valor_crianca, o_que_inclui, ponto_de_encontro,
      tipo_veiculo, capacidade_passageiros, trecho_principal, valor_trecho,
      observacoes, keywords, priority, ativo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      nome_servico, category,
      descricao_completa || null, roteiro || null, duracao || null,
      valor_adulto || null, valor_crianca || null,
      o_que_inclui || null, ponto_de_encontro || null,
      tipo_veiculo || null, capacidade_passageiros || null,
      trecho_principal || null, valor_trecho || null,
      observacoes || null,
      keywords ? `{${keywords.join(",")}}` : null,
      priority || 1, ativo !== false,
    ]
  );

  return Response.json({ ok: true, id: result[0]?.id });
}

export async function PUT(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { id, ...fields } = body;

  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const allowedFields = [
    "nome_servico", "category", "descricao_completa", "roteiro", "duracao",
    "valor_adulto", "valor_crianca", "o_que_inclui", "ponto_de_encontro",
    "tipo_veiculo", "capacidade_passageiros", "trecho_principal", "valor_trecho",
    "observacoes", "priority", "ativo",
  ];

  for (const field of allowedFields) {
    if (field in fields) {
      params.push(fields[field]);
      setClauses.push(`${field} = $${params.length}`);
    }
  }

  // Handle keywords array separately
  if ("keywords" in fields) {
    const kw = fields.keywords;
    params.push(kw && kw.length > 0 ? `{${kw.join(",")}}` : null);
    setClauses.push(`keywords = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  setClauses.push("updated_at = NOW()");

  params.push(id);
  await query(
    `UPDATE servicos SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
    params
  );

  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { id } = body;

  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  await query(`DELETE FROM servicos WHERE id = $1`, [id]);
  return Response.json({ ok: true });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
