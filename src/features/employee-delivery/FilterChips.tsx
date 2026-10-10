import { translateUi, useLanguage } from '../../i18n';
export function FilterChips({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  useLanguage();
  return (
    <section className="employee-chip-filter" aria-label={translateUi('กรองตาม{0}', { 0: label })}>
      <span>{icon}{label}</span>
      <div>
        {options.map((option) => (
          <button
            aria-pressed={value === option.value}
            className={value === option.value ? 'employee-chip--selected' : ''}
            key={`${label}-${option.value || 'all'}`}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
