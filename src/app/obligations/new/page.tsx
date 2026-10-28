import { PageHeader } from "@/components/ui";
import { NewObligationForm } from "./NewObligationForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "New payment request" };

export default function NewObligationPage() {
  return (
    <>
      <PageHeader title="New payment request" lede="Paste the request as it arrived. The agent reads it, policy checks it against the evidence, and the router quotes both rails." />
      <NewObligationForm />
    </>
  );
}
