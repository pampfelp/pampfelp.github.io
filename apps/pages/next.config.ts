import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "export",
	basePath: "/opencut",
	trailingSlash: true,
	images: { unoptimized: true },
};

export default nextConfig;
