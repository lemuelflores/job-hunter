import { notFound } from 'next/navigation.js';
import { InboxPage } from '../inbox-page.tsx';

export const dynamic = 'force-dynamic';

export default async function ListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  return <InboxPage id={Number(id)} />;
}
