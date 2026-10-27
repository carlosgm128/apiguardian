import { Analytics } from "@vercel/analytics/react";
import { useRoute } from "../hooks/hooks";

// Vercel Web Analytics for the hosted demo (cookieless page views only).
// Routes live in the hash, which Vercel doesn't see, so each view is reported
// as a path plus a pattern with ids replaced: /runs/[id]/inference/[item].
export default function DemoAnalytics() {
  const [page, id, tab, item] = useRoute();
  const path = "/" + [page, id, tab, item].filter((p): p is string => Boolean(p)).map((p) => encodeURIComponent(p)).join("/");
  const route = "/" + [page, id && "[id]", tab, item && "[item]"].filter(Boolean).join("/");
  return <Analytics route={route} path={path} />;
}
