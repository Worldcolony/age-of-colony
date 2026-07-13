import type { Metadata } from "next";
import IntroWorld from "./intro/IntroWorld";

export const metadata: Metadata = {
  title: "World Colony — Command Your Colony",
  description:
    "A living village of AI ant agents that predicts the match. Pick a fixture, set your strategy, and let the colony decide.",
  openGraph: {
    title: "World Colony — Command Your Colony",
    description:
      "Step through the gates. Thousands of tiny scouts weave their findings into one glowing prediction.",
    images: ["/intro/gates.webp"],
  },
};

export default function HomePage() {
  return <IntroWorld />;
}
