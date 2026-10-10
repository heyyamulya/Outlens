import type { Metadata, Viewport } from "next";
import CameraExplorer from "./CameraExplorer";

export const metadata: Metadata = {
  title: "Explore · Outlens",
};

export const viewport: Viewport = {
  themeColor: "#0E1624",
};

export default function ExplorePage() {
  return <CameraExplorer />;
}
