import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { ServiceWorkerRegister } from "@/components/pwa/sw-register";
import { PushNotificationsPrompt } from "@/components/pwa/push-notifications";
import { ThemeProvider } from "next-themes";
import { HtmlLangSetter } from "@/components/i18n/html-lang-setter";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

const siteUrl = "https://aspidus.onrender.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "VELOS — Trade Management Platform",
    template: "%s · VELOS",
  },
  description:
    "International trade CRM with multi-tenancy, compliance, and document automation. Powered by Aspidus.",
  applicationName: "VELOS",
  keywords: [
    "VELOS",
    "trade CRM",
    "trade ERP",
    "commodity trading",
    "multi-tenant",
    "trade finance",
    "document automation",
    "compliance",
  ],
  authors: [{ name: "VELOS" }],
  creator: "VELOS",
  publisher: "VELOS",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon", sizes: "32x32", type: "image/png" },
    ],
    apple: [
      { url: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    title: "VELOS",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "VELOS",
    title: "VELOS — Trade Management Platform",
    description:
      "International trade CRM with multi-tenancy, compliance, and document automation.",
  },
  twitter: {
    card: "summary",
    title: "VELOS — Trade Management Platform",
    description:
      "International trade CRM with multi-tenancy, compliance, and document automation.",
  },
};

export const viewport: Viewport = {
  themeColor: "#B45309",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* iOS / Android PWA "Add to Home Screen" support.
            The Next.js Metadata API (appleWebApp config above) already
            generates apple-mobile-web-app-* tags; these are added
            explicitly as belt-and-suspenders for older iOS Safari
            versions and legacy Android Chrome (mobile-web-app-capable). */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="VELOS" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          <Providers>
            <HtmlLangSetter />
            {children}
            <Toaster richColors position="top-right" />
            <ServiceWorkerRegister />
            <PushNotificationsPrompt />
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
