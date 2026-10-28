import type { ReactNode } from 'react';
import './inbox.css';

export const metadata = { title: 'Job Hunter' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
