import type { Metadata } from "next";
import { ContextView, parseContextSearch } from "./_components/ContextView";

export const metadata: Metadata = { title: "Project Context" };

type Props = {
  params: Promise<{ repoId: string }>;
  searchParams: Promise<{ doc?: string | string[] }>;
};

/* Route: /repos/:repoId/context — browse the repo's spec / doc / insight
   markdown files. Thin entry: resolves the repo id and ?doc=, the screen lives
   in _components/ContextView. */
export default async function ContextPage({ params, searchParams }: Props) {
  const [{ repoId }, search] = await Promise.all([params, searchParams]);
  return <ContextView repoId={repoId} {...parseContextSearch(search)} />;
}
