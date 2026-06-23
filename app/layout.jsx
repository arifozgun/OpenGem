import "./globals.css";

const appearanceScript = `
(function () {
  try {
    var theme = localStorage.getItem("opengem-theme") || "light";
    var color = localStorage.getItem("opengem-highlight") || "#ea580c";
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#ea580c";
    var dark = theme === "dark" || (theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    root.style.setProperty("--highlight-color", color.toLowerCase());
    var r = parseInt(color.slice(1, 3), 16) / 255;
    var g = parseInt(color.slice(3, 5), 16) / 255;
    var b = parseInt(color.slice(5, 7), 16) / 255;
    var normalize = function (c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var luminance = 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
    root.style.setProperty("--highlight-foreground", luminance > 0.55 ? "#111827" : "#ffffff");
  } catch (e) {}
})();
`;

export const metadata = {
  title: "OpenGem",
  description: "Self-hosted AI API gateway for Gemini, OpenAI and Anthropic compatible clients.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
  icons: {
    icon: [
      { url: "/logo-black.png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-white.png", media: "(prefers-color-scheme: dark)" },
    ],
    shortcut: [
      { url: "/logo-black.png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-white.png", media: "(prefers-color-scheme: dark)" },
    ],
    apple: [
      { url: "/logo-black.png", media: "(prefers-color-scheme: light)" },
      { url: "/logo-white.png", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
