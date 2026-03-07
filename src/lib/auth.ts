import { NextRequest } from "next/server";

export function validateApiSecret(req: NextRequest): boolean {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  return secret === process.env.API_SECRET;
}
