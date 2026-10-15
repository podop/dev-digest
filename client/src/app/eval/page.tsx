import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { EvalDashboardView } from "./_components/EvalDashboardView";
import { resolveAgentId } from "./helpers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("eval");
  return { title: t("page.metaTitle") };
}

type Props = { searchParams: Promise<{ agent?: string | string[] }> };

/* Route: /eval — Eval Dashboard: all agents, or one agent's view with ?agent=<id>.
   Thin entry: resolves ?agent=, the screen lives in _components/EvalDashboardView. */
export default async function EvalPage({ searchParams }: Props) {
  const { agent } = await searchParams;
  return <EvalDashboardView agentId={resolveAgentId(agent)} />;
}
