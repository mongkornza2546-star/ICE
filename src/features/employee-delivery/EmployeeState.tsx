import { Storefront } from '@phosphor-icons/react';

export function EmployeeState({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="employee-state">
      <Storefront aria-hidden="true" size={42} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}
