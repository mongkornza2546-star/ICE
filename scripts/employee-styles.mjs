// Only namespaces owned by management screens belong here. Shared styles such as
// credit-ar (employee bills), image-preview, buttons, fonts and animations stay.
const managementClasses = [
  /^(?:admin-|accounting-|manager-|dashboard-|ref-|reference-)/,
  /^(?:factory-order|collection-desk|rented-tank)(?:$|[-_])/,
  /^shop-(?:editor|directory|settings|catalog|summary|purchase|page|filter|import|view|search|stall|readiness|rental)(?:$|[-_])/,
  /^event-(?!spin$)/,
  /^stock-(?:layout|refresh|location|balance|ledger|count|v2|variance|close|action|current)(?:$|[-_])/,
  /^(?:daily-(?:stock|close)(?:$|[-_])|holder-)/,
];

/** @returns {import('postcss').Plugin} */
export function employeeStyles() {
  return {
    postcssPlugin: 'employee-styles',
    OnceExit(root, { list }) {
      root.walkRules((rule) => {
        // Deliberately require a leading, positive class selector. A class inside
        // :not(), :is() or an attribute is not proof the rule is admin-only.
        const original = list.comma(rule.selector);
        const selectors = original.filter((selector) => {
          const leadingClass = /^\.([\w-]+)/.exec(selector.trim())?.[1];
          return !leadingClass || !managementClasses.some((pattern) => pattern.test(leadingClass));
        });
        if (selectors.length === 0) rule.remove();
        else if (selectors.length !== original.length) {
          rule.selector = selectors.join(', ');
        }
      });
      // Remove empty responsive wrappers without moving retained rules or changing
      // their specificity. This runs after Vite has resolved CSS @imports.
      root.walkAtRules((rule) => {
        if (rule.nodes && rule.nodes.every((node) => node.type === 'comment')) rule.remove();
      });
    },
  };
}
