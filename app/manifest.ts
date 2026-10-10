import type { MetadataRoute } from "next";

// Lets people add Outlens to their home screen; it then opens full-screen, like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Outlens",
    short_name: "Outlens",
    description: "Look at anything: see its outline, estimated color and name, then see it in colors you can tell apart.",
    start_url: "/explore",
    display: "standalone",
    background_color: "#0E1624",
    theme_color: "#0E1624",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
