import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PlatePilot Restaurant Operations OS",
    short_name: "PlatePilot",
    description: "Restaurant inventory, food cost, waste and profit control.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f7f7f2",
    theme_color: "#166534",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ]
  };
}
