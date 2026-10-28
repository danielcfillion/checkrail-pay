import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";

/** Shown when a vendor id does not resolve: usually an old link from before a demo reset. */
export default function VendorNotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        title="That vendor does not exist"
        body="It may have been removed when the demo was reset. Ids change on every reset."
        action={
          <Link href="/vendors" className="btn">
            Back to vendors
          </Link>
        }
      />
    </>
  );
}
