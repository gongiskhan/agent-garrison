import { Bot, Mail, MessageCircle, Hash } from 'lucide-react';
import type { Provider } from './types';
import styles from './messages.module.css';

export function ProviderBadge({ provider, account, id }: { provider?: Provider; account?: string; id?: string }) {
  const glyph = provider?.badge.glyph.toLowerCase() || '';
  const Icon = provider?.kind === 'system' || id === 'system' || glyph === 'bot' ? Bot : provider?.kind === 'mail' || glyph === 'mail' ? Mail : glyph === 'hash' ? Hash : MessageCircle;
  const label = provider?.badge.text || provider?.label || (id === 'system' ? 'Garrison' : id || 'Messages');
  const accountLabel = (provider?.accounts.length || 0) > 1 ? provider?.accounts.find(item => item.id === account)?.label : null;
  return <span className={styles.badge} data-testid="provider-badge" style={provider?.badge.color && /^#[0-9a-f]{3,8}$/i.test(provider.badge.color) ? { borderColor: provider.badge.color } : undefined}><Icon size={12} aria-hidden="true" /><span>{label}{accountLabel ? ` · ${accountLabel}` : ''}</span></span>;
}
