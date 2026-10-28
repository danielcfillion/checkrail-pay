import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";

/** Shown when a payment request id does not resolve: usually an old link from before a demo reset. */
export default function RequestNotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        title="That payment request does not exist"
        body="It may have been removed when the demo was reset. Ids change on every reset."
        action={
          <Link href="/obligations" className="btn">
            Back to the inbox
          </Link>
        }
      />
    </>
  );
}
