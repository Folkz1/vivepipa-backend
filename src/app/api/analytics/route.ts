import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { validateApiSecret } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!validateApiSecret(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [
    totalConversations,
    totalLeads,
    totalMessages,
    messagesPerDay,
    leadsByStatus,
    recentActivity,
  ] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) as count FROM conversations`),
    query<{ count: string }>(`SELECT COUNT(*) as count FROM leads`),
    query<{ count: string }>(`SELECT COUNT(*) as count FROM messages`),
    query<{ day: string; count: string }>(
      `SELECT DATE(created_at) as day, COUNT(*) as count
       FROM messages
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY day DESC`
    ),
    query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count FROM leads GROUP BY status`
    ),
    query<{ day: string; conversations: string; messages: string; leads: string }>(
      `SELECT
         DATE(d) as day,
         (SELECT COUNT(*) FROM conversations WHERE DATE(created_at) = DATE(d)) as conversations,
         (SELECT COUNT(*) FROM messages WHERE DATE(created_at) = DATE(d)) as messages,
         (SELECT COUNT(*) FROM leads WHERE DATE(created_at) = DATE(d)) as leads
       FROM generate_series(NOW() - INTERVAL '7 days', NOW(), '1 day') d
       ORDER BY day DESC`
    ),
  ]);

  const qualified = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM leads WHERE status IN ('qualified', 'converted')`
  );

  const conversionRate =
    parseInt(totalLeads[0]?.count || "0") > 0
      ? (parseInt(qualified[0]?.count || "0") / parseInt(totalLeads[0]?.count || "1") * 100).toFixed(1)
      : "0";

  return Response.json({
    summary: {
      total_conversations: parseInt(totalConversations[0]?.count || "0"),
      total_leads: parseInt(totalLeads[0]?.count || "0"),
      total_messages: parseInt(totalMessages[0]?.count || "0"),
      conversion_rate: parseFloat(conversionRate),
    },
    messages_per_day: messagesPerDay,
    leads_by_status: leadsByStatus,
    recent_activity: recentActivity,
  });
}
