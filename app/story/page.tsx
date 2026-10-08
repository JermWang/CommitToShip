import { permanentRedirect } from "next/navigation";

// The story is the homepage now; keep old /story links working.
export default function StoryPage() {
  permanentRedirect("/");
}
