import "./globals.css";
export const metadata = {
  title: "Truex · Agent workspace",
  description: "A workspace for conversations with your agents",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
