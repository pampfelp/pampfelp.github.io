import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Inter } from "next/font/google";
import type { Metadata } from "next";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
	title: "OpenCut Pessoal",
	description: "Editor de vídeo pessoal",
	robots: { index: false, follow: false },
	manifest: "/opencut/manifest.json",
	icons: { icon: "/opencut/favicon.ico" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="pt-BR" suppressHydrationWarning>
			<body className={`${siteFont.className} font-sans antialiased`}>
				<ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange>
					<TooltipProvider>
						<Toaster />
						{children}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
