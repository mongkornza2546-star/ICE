import type { ReactNode } from 'react';
import { translateUi, useLanguage } from '../../i18n';

export function Panel({ title, description, children, label, className = '', id, action }: {
  title: string; description?: string; children: ReactNode; label?: string;
  className?: string; id?: string; action?: ReactNode;
}) {
  useLanguage();
  return <section aria-label={label ?? title} className={`executive-panel ${className}`} id={id} tabIndex={id ? -1 : undefined}>
    <div className="executive-panel__head"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{action}</div>
    {children}
  </section>;
}

export function DataTable({ headings, children, label }: { headings: string[]; children: ReactNode; label: string }) {
  useLanguage();
  return <div className="executive-data-table__scroll"><table aria-label={label} className="executive-data-table">
    <thead><tr>{headings.map((heading) => <th key={heading} scope="col">{translateUi(heading)}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}

/** Horizontal 100% bar with an accessible text summary. */
export function StackBar({ label, segments }: {
  label: string; segments: Array<{ key: string; value: number; tone: string }>;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  return <div aria-label={label} className="executive-stack-bar" role="img">
    {total > 0 ? segments.filter((segment) => segment.value > 0).map((segment) =>
      <i className={`executive-tone--${segment.tone}`} key={segment.key} style={{ width: `${segment.value / total * 100}%` }} />) : null}
  </div>;
}
