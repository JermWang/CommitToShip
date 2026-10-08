import type { Metadata } from "next";

import StoryExperience from "./StoryExperience";

export const metadata: Metadata = {
  title: "How it works",
  description: "Scroll through how Ship & Commit locks creator fees behind milestones that holders verify, from launch to payout.",
};

export default function StoryPage() {
  return (
    <main className="storyMain">
      <StoryExperience />
    </main>
  );
}
