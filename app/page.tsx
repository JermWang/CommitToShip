import HomeApp from "./HomeApp";
import StoryExperience from "./story/StoryExperience";

/**
 * "/" is the cinematic "how it works" story. The launchpad tabs (?tab=commit, ?tab=discover) still live
 * at "/" so every existing link keeps working.
 */
export default function Page({ searchParams }: { searchParams: { tab?: string | string[] } }) {
  const raw = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab;
  const tab = String(raw ?? "").toLowerCase();
  if (tab === "commit" || tab === "discover") return <HomeApp />;

  return (
    <main className="storyMain">
      <StoryExperience />
    </main>
  );
}
