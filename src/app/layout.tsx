import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { AppProviders } from "@/components/providers/app-providers";
import messages from "@/messages/en.json";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Yield",
  title: { default: "Yield Restaurant OS", template: "%s | Yield" },
  description: "Inventory, recipe costing, waste and restaurant profitability in one operating system.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Yield", statusBarStyle: "default" },
};
export const viewport: Viewport = { themeColor: "#166534" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <NextIntlClientProvider locale="en" messages={messages}>
          <AppProviders>{children}</AppProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
