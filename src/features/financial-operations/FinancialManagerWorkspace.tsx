import type { ComponentProps } from 'react';
import { CollectionDesk } from './components/CollectionDesk';
import { CreditReceivablesManager } from './components/CreditReceivablesManager';
import { DailyCreditAcknowledgementPanel } from './components/DailyCreditAcknowledgementPanel';
import { AccountingPage } from '../accounting/AccountingPage';

export default function FinancialManagerWorkspace({ page, collection, accounting, signoff, credit }: {
  page: 'collection' | 'transactions' | 'credit' | 'credit_signoff';
  collection: ComponentProps<typeof CollectionDesk>;
  accounting: ComponentProps<typeof AccountingPage>;
  signoff: ComponentProps<typeof DailyCreditAcknowledgementPanel>;
  credit: ComponentProps<typeof CreditReceivablesManager>;
}) {
  if (page === 'collection') return <CollectionDesk {...collection} />;
  if (page === 'transactions') return <AccountingPage {...accounting} />;
  if (page === 'credit_signoff') return <DailyCreditAcknowledgementPanel {...signoff} />;
  return <CreditReceivablesManager {...credit} />;
}
