import { MessagesPage } from '@/components/messages/MessagesPage';
export default function Message({ params }: { params: { id: string } }) { return <MessagesPage messageId={params.id} />; }
