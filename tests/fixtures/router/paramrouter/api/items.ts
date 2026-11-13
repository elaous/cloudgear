import type { VercelRequest, VercelResponse } from "@cloudgear/functions";

export default function items(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ route: "items", dbUrl: process.env.ITEMS_DB });
}
