/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@napi-rs/canvas', 'unpdf', 'jsdom'],
}

export default nextConfig
