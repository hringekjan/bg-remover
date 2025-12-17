import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'BG-Remover - CarouselLabs',
  description: 'AI-powered background removal service using AWS Bedrock Claude Vision',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{
        margin: 0,
        padding: 0,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        backgroundColor: '#f5f5f5',
        minHeight: '100vh',
      }}>
        {children}
      </body>
    </html>
  );
}
