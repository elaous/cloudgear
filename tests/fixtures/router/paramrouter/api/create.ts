import type { VercelRequest, VercelResponse } from "@cloudgear/functions";

export default function create(req: VercelRequest, res: VercelResponse) {
  res.status(201).json({ route: "create", key: process.env.CREATE_KEY });
}
