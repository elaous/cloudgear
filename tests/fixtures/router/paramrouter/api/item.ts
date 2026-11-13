import type { VercelRequest, VercelResponse } from "@cloudgear/functions";

export default function item(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ route: "item", id: req.query.id });
}
