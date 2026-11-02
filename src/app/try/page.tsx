import Link from "next/link";
import { TryItYourself } from "@/components/try/TryItYourself";
import { tryRefusal } from "@/components/try/guard";
import { sampleById, type SampleId } from "@/components/try/samples";

export const dynamic = "force-dynamic";
export const metadata = { title: "Try it yourself" };

/**
 * Try it yourself: a judge takes one supplier payment through the clerk's steps in their own copy of the demo.
 * Refused (with the reason) on live rails, wherever real money can move, or without a private sandbox copy.
 */
export default async function TryPage({ searchParams }: { searchParams: Promise<{ sample?: string; mode?: string }> }) {
  const refused = tryRefusal();
  if (refused) {
    return (
      <section className="panel max-w-2xl px-5 py-5">
        <h1 className="text-[22px] font-semibold">Try it yourself is not available here</h1>
        <p className="mt-2 text-ink-soft">{refused}</p>
        <p className="mt-4">
          <Link className="link" href="/">
            Back to the overview
          </Link>
        </p>
      </section>
    );
  }
  const q = await searchParams;
  const sample = (sampleById(q.sample ?? "")?.id ?? "clean") as SampleId;
  return <TryItYourself initialSample={sample} startGuided={q.mode !== "free"} />;
}
