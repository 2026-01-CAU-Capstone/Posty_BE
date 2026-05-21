export const metadata = {
  title: 'Posty Prototype',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 16 }}>{children}</body>
    </html>
  );
}
