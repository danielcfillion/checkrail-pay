import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: { absolute: "Page not found, Checkrail Pay" } };

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        title="This page does not exist"
        body="Check the address, or start again from the overview or the inbox."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/" className="btn btn-primary">
              Overview
            </Link>
            <Link href="/obligations" className="btn">
              Inbox
            </Link>
          </div>
        }
      />
    </>
  );
}
