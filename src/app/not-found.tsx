import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        title="That record does not exist"
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
