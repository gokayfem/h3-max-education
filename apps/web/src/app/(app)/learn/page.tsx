import type { Metadata } from "next";
import { AuthError, getSession } from "@/lib/server/auth";
import { LearnClient } from "./LearnClient";

export const metadata: Metadata = {
  title: "Lesson",
};

export default async function LearnPage() {
  let learnerId: string | undefined;

  try {
    learnerId = (await getSession())?.learnerId;
  } catch (error) {
    if (
      !(error instanceof AuthError) ||
      error.code !== "authentication_required"
    ) {
      throw error;
    }
  }

  return <LearnClient learnerId={learnerId} />;
}
