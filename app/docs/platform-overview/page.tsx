import fs from "fs/promises";
import path from "path";
import DocsShell from "@/app/components/DocsShell";
import MarkdownRenderer from "@/app/components/MarkdownRenderer";

export const runtime = "nodejs";

export const metadata = {
  title: "Platform overview",
  description:
    "How Ship & Commit works: launch on pump.fun, lock creator fees in escrow, commit to milestones, let holders verify, and release or forfeit.",
};

export default async function PlatformOverviewPage() {
  const filePath = path.join(process.cwd(), "docs", "platform-overview.md");
  const md = await fs.readFile(filePath, "utf8");

  return (
    <main className="docPage">
      <DocsShell>
        <article className="docArticle">
          <MarkdownRenderer content={md} />
        </article>
      </DocsShell>
    </main>
  );
}
